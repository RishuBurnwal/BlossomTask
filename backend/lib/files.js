import fs from "node:fs";
import path from "node:path";

const outputsRoot = path.resolve(process.cwd(), "Scripts", "outputs");

const STATUS_FIELDS = ["perplexity_status", "pplx_status", "status"];

function sanitizeRelativePath(inputPath = "") {
  const normalized = path.normalize(inputPath).replace(/^([/\\])+/, "");
  if (normalized.includes("..")) {
    throw new Error("Invalid path");
  }
  return normalized;
}

export function resolveOutputPath(inputPath = "") {
  const relative = sanitizeRelativePath(inputPath);
  const absolute = path.resolve(outputsRoot, relative);
  if (!absolute.startsWith(outputsRoot)) {
    throw new Error("Path traversal blocked");
  }
  return absolute;
}

function walkTree(basePath) {
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

  const dataRows = rows.slice(1, 1 + limit);
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
    return rowObject;
  });
}

export function readFileContent(inputPath, limit = 200) {
  const targetPath = resolveOutputPath(inputPath);
  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    throw new Error("File not found");
  }

  const ext = path.extname(targetPath).toLowerCase();
  const raw = fs.readFileSync(targetPath, "utf-8");

  if (ext === ".json") {
    const json = JSON.parse(raw);
    return { type: "json", raw, parsed: Array.isArray(json) ? json.slice(0, limit) : json };
  }

  if (ext === ".jsonl") {
    const parsed = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { line };
        }
      });
    return { type: "jsonl", raw, parsed };
  }

  if (ext === ".csv") {
    return { type: "csv", raw, parsed: parseCsv(raw, limit) };
  }

  return { type: "text", raw, parsed: raw.split(/\r?\n/).slice(0, limit) };
}

function summarizeRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { total: 0, matched: 0, needs_review: 0, unmatched: 0, last_processed_at: null };
  }

  let matched = 0;
  let needs_review = 0;
  let unmatched = 0;
  let lastProcessedAt = null;

  rows.forEach((row) => {
    const status = STATUS_FIELDS.map((key) => row?.[key]).find((value) => Boolean(value)) || "";
    const norm = String(status || "").trim().toLowerCase();
    if (norm === "matched") matched += 1;
    else if (norm === "needs_review" || norm === "needs-review" || norm === "needs review") needs_review += 1;
    else if (norm === "mismatched" || norm === "unmatched") unmatched += 1;

    const processed = row?.processed_at_utc || row?.processedAtUtc || row?.processedAt;
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
    matched,
    needs_review,
    unmatched,
    last_processed_at: lastProcessedAt,
  };
}

export function getDefaultDatasets(limit = 200) {
  // Single-file output expectation
  const mainPath = "master/master_records.csv";
  let mainRows = [];
  try {
    mainRows = readFileContent(mainPath, limit).parsed;
  } catch {
    mainRows = [];
  }

  const summary = summarizeRows(mainRows);

  return {
    main: { file: mainPath, rows: mainRows, summary },
    error: { file: "", rows: [] },
    low: { file: "", rows: [] },
    review: { file: "", rows: [] },
  };
}
