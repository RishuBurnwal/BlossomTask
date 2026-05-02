import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

function getOutputsRoot() {
  return path.resolve(process.cwd(), "Scripts", "outputs");
}

export const STATUS_FIELDS = ["perplexity_status", "pplx_status", "status", "match_status", "trResult"];

export const DATASET_CANDIDATES = {
  main: [
    "Funeral_Finder/Funeral_data.xlsx",
    "Funeral_Finder/Funeral_data.csv",
    "master/master_records.csv",
  ],
  found: [
    "Funeral_Finder/Funeral_data_found.xlsx",
    "Funeral_Finder/Funeral_data_found.csv",
  ],
  customer: [
    "Funeral_Finder/Funeral_data_customer.xlsx",
    "Funeral_Finder/Funeral_data_customer.csv",
  ],
  not_found: [
    "Funeral_Finder/Funeral_data_not_found.xlsx",
    "Funeral_Finder/Funeral_data_not_found.csv",
  ],
  review: [
    "Funeral_Finder/Funeral_data_review.xlsx",
    "Funeral_Finder/Funeral_data_review.csv",
  ],
};

const STATUS_NORMALIZATION = new Map([
  ["matched", "found"],
  ["found", "found"],
  ["confirmed", "found"],
  ["customer", "customer"],
  ["customer_defined", "customer"],
  ["customer-defined", "customer"],
  ["customer provided", "customer"],
  ["customer-provided", "customer"],
  ["instruction_only", "customer"],
  ["instruction-only", "customer"],
  ["needs_review", "review"],
  ["needs-review", "review"],
  ["needs review", "review"],
  ["review", "review"],
  ["uncertain", "review"],
  ["mismatched", "notfound"],
  ["unmatched", "notfound"],
  ["notfound", "notfound"],
  ["not_found", "notfound"],
  ["not found", "notfound"],
]);

function sanitizeRelativePath(inputPath = "") {
  const normalized = path.normalize(inputPath).replace(/^([/\\])+/, "");
  if (normalized.includes("..")) {
    throw new Error("Invalid path");
  }
  return normalized;
}

function normalizeLimit(limit = 200) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(parsed));
}

function applyLimit(items = [], limit = 200) {
  const normalized = normalizeLimit(limit);
  return normalized > 0 ? items.slice(0, normalized) : items;
}

export function resolveOutputPath(inputPath = "") {
  const outputsRoot = getOutputsRoot();
  const relative = sanitizeRelativePath(inputPath);
  const absolute = path.resolve(outputsRoot, relative);
  if (!absolute.startsWith(outputsRoot)) {
    throw new Error("Path traversal blocked");
  }
  return absolute;
}

function walkTree(basePath) {
  const outputsRoot = getOutputsRoot();
  const entries = fs.readdirSync(basePath, { withFileTypes: true });
  const rows = [];

  entries.forEach((entry) => {
    const entryPath = path.join(basePath, entry.name);
    const relPath = path.relative(outputsRoot, entryPath).replaceAll("\\", "/");
    const isDirectory = entry.isDirectory();

    rows.push({
      name: entry.name,
      path: relPath,
      type: isDirectory ? "directory" : "file",
      size: isDirectory ? null : fs.statSync(entryPath).size,
    });

    if (isDirectory) {
      rows.push(...walkTree(entryPath));
    }
  });

  return rows;
}

export function listTree(inputPath = "", options = {}) {
  const recursive = Boolean(options.recursive);
  const outputsRoot = getOutputsRoot();
  const targetPath = resolveOutputPath(inputPath);
  if (!fs.existsSync(targetPath)) {
    return [];
  }

  const entries = recursive
    ? walkTree(targetPath)
    : fs.readdirSync(targetPath, { withFileTypes: true }).map((entry) => {
        const entryPath = path.join(targetPath, entry.name);
        const relPath = path.relative(outputsRoot, entryPath).replaceAll("\\", "/");
        return {
          name: entry.name,
          path: relPath,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? fs.statSync(entryPath).size : null,
        };
      });

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function parseCsvRows(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (character === '"') {
      if (inQuotes && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && content[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += character;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function parseCsv(content, limit = 200) {
  const rows = parseCsvRows(content).filter((cells) => cells.some((value) => String(value || "").trim() !== ""));
  if (rows.length === 0) {
    return [];
  }

  const rawHeaders = rows[0];
  const headers = rawHeaders.map((header, index) => {
    const cleaned = String(header ?? "").replace(/^\uFEFF/, "").trim();
    return cleaned || `column_${index + 1}`;
  });

  const dataRows = normalizeLimit(limit) > 0
    ? rows.slice(1, 1 + normalizeLimit(limit))
    : rows.slice(1);
  return dataRows.map((cells) => {
    const rowObject = {};
    headers.forEach((header, index) => {
      rowObject[header] = cells[index] ?? "";
    });
    if (cells.length > headers.length) {
      for (let index = headers.length; index < cells.length; index += 1) {
        rowObject[`extra_${index - headers.length + 1}`] = cells[index] ?? "";
      }
    }
    return normalizeRowObject(rowObject);
  });
}

function normalizeRowObject(row = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }

  const normalized = { ...row };
  const aliases = {
    trresult: "trResult",
    trtext: "trText",
    trenddate: "trEndDate",
    ord_id: "ord_id",
    ordid: "ord_id",
    order_id: "order_id",
  };

  Object.entries(row).forEach(([key, value]) => {
    const canonicalKey = aliases[String(key).toLowerCase()] || key;
    if (canonicalKey !== key) {
      normalized[canonicalKey] = value;
      delete normalized[key];
    }
  });

  return normalized;
}

function parseXlsx(buffer, limit = 200) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const firstSheet = workbook.SheetNames?.[0];
  if (!firstSheet) {
    return [];
  }

  const worksheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false });
  const parsedRows = normalizeLimit(limit) > 0 ? rows.slice(0, normalizeLimit(limit)) : rows;
  return parsedRows.map((row) => normalizeRowObject(row));
}

export function readFileContent(inputPath, limit = 200) {
  const targetPath = resolveOutputPath(inputPath);
  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    throw new Error("File not found");
  }

  const ext = path.extname(targetPath).toLowerCase();

  if (ext === ".xlsx") {
    try {
      const xlsxBuffer = fs.readFileSync(targetPath);
      const parsed = parseXlsx(xlsxBuffer, limit);
      if (parsed.length > 0) {
        return { type: "xlsx", raw: `[xlsx:${path.basename(targetPath)}]`, parsed };
      }

      const csvFallbackPath = targetPath.replace(/\.xlsx$/i, ".csv");
      if (fs.existsSync(csvFallbackPath) && fs.statSync(csvFallbackPath).isFile()) {
        const csvRaw = fs.readFileSync(csvFallbackPath, "utf-8");
        const csvParsed = parseCsv(csvRaw, limit);
        if (csvParsed.length > 0) {
          return { type: "csv", raw: csvRaw, parsed: csvParsed };
        }
      }

      return { type: "xlsx", raw: `[xlsx:${path.basename(targetPath)}]`, parsed };
    } catch {
      const csvFallbackPath = targetPath.replace(/\.xlsx$/i, ".csv");
      if (fs.existsSync(csvFallbackPath) && fs.statSync(csvFallbackPath).isFile()) {
        const csvRaw = fs.readFileSync(csvFallbackPath, "utf-8");
        return { type: "csv", raw: csvRaw, parsed: parseCsv(csvRaw, limit) };
      }
    }
  }

  const raw = fs.readFileSync(targetPath, "utf-8");

  if (ext === ".json") {
    const json = JSON.parse(raw);
    return {
      type: "json",
      raw,
      parsed: Array.isArray(json)
        ? applyLimit(json, limit).map((row) => normalizeRowObject(row))
        : normalizeRowObject(json),
    };
  }

  if (ext === ".jsonl") {
    const parsed = applyLimit(
      raw.split(/\r?\n/).filter(Boolean),
      limit,
    ).map((line) => {
      try {
        return normalizeRowObject(JSON.parse(line));
      } catch {
        return { line };
      }
    });
    return { type: "jsonl", raw, parsed };
  }

  if (ext === ".csv") {
    const parsed = parseCsv(raw, limit);
    if (parsed.length > 0) {
      return { type: "csv", raw, parsed };
    }

    const xlsxFallbackPath = targetPath.replace(/\.csv$/i, ".xlsx");
    if (fs.existsSync(xlsxFallbackPath) && fs.statSync(xlsxFallbackPath).isFile()) {
      try {
        const xlsxBuffer = fs.readFileSync(xlsxFallbackPath);
        const xlsxParsed = parseXlsx(xlsxBuffer, limit);
        if (xlsxParsed.length > 0) {
          return { type: "xlsx", raw: `[xlsx:${path.basename(xlsxFallbackPath)}]`, parsed: xlsxParsed };
        }
      } catch {
        // Keep csv parse result when xlsx fallback parsing fails.
      }
    }

    return { type: "csv", raw, parsed };
  }

  return { type: "text", raw, parsed: applyLimit(raw.split(/\r?\n/), limit) };
}

export function normalizeStatusValue(value = "") {
  const key = String(value || "").trim().toLowerCase();
  return STATUS_NORMALIZATION.get(key) || "unknown";
}

export function getRowStatus(row = {}) {
  const statusValue = STATUS_FIELDS.map((key) => row?.[key]).find((value) => String(value || "").trim());
  return normalizeStatusValue(statusValue);
}

export function summarizeRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      total: 0,
      customer: 0,
      found: 0,
      notfound: 0,
      review: 0,
      unknown: 0,
      last_processed_at: null,
    };
  }

  let customer = 0;
  let found = 0;
  let notfound = 0;
  let review = 0;
  let unknown = 0;
  let lastProcessedAt = null;

  rows.forEach((row) => {
    const normalizedStatus = getRowStatus(row);
    if (normalizedStatus === "customer") customer += 1;
    else if (normalizedStatus === "found") found += 1;
    else if (normalizedStatus === "notfound") notfound += 1;
    else if (normalizedStatus === "review") review += 1;
    else unknown += 1;

    const processed = row?.last_processed_at || row?.processed_at_utc || row?.processedAtUtc || row?.processedAt;
    if (processed) {
      const parsedDate = new Date(processed);
      if (!Number.isNaN(parsedDate.getTime())) {
        const ts = parsedDate.toISOString();
        if (!lastProcessedAt || ts > lastProcessedAt) {
          lastProcessedAt = ts;
        }
      }
    }
  });

  return {
    total: rows.length,
    customer,
    found,
    notfound,
    review,
    unknown,
    last_processed_at: lastProcessedAt,
  };
}

function sortDatasetCandidates(candidatePaths = []) {
  return [...candidatePaths]
    .map((candidatePath, index) => {
      const absolutePath = resolveOutputPath(candidatePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        return null;
      }
      return {
        candidatePath,
        index,
        updatedAtMs: fs.statSync(absolutePath).mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.updatedAtMs !== left.updatedAtMs) {
        return right.updatedAtMs - left.updatedAtMs;
      }
      return left.index - right.index;
    });
}

export function readDataset(candidatePaths, limit) {
  const sortedCandidates = sortDatasetCandidates(candidatePaths);
  const attemptOrder = sortedCandidates.length > 0
    ? sortedCandidates.map((entry) => entry.candidatePath)
    : candidatePaths;

  for (const candidatePath of attemptOrder) {
    try {
      const content = readFileContent(candidatePath, limit);
      const rows = Array.isArray(content.parsed) ? content.parsed : [];
      if (rows.length > 0) {
        return { file: candidatePath, rows, summary: summarizeRows(rows) };
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return { file: attemptOrder[0] || candidatePaths[0] || "", rows: [], summary: summarizeRows([]) };
}

export function getDefaultDatasets(limit = 200) {
  const main = readDataset(DATASET_CANDIDATES.main, limit);
  const found = readDataset(DATASET_CANDIDATES.found, limit);
  const customer = readDataset(DATASET_CANDIDATES.customer, limit);
  const notFound = readDataset(DATASET_CANDIDATES.not_found, limit);
  const review = readDataset(DATASET_CANDIDATES.review, limit);

  return {
    main,
    found,
    customer,
    not_found: notFound,
    review,
    error: notFound,
    low: notFound,
  };
}
