import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import mysql from "mysql2/promise";

import { createId } from "./storage.js";
import { DATASET_CANDIDATES, getRowStatus, normalizeStatusValue, readFileContent, resolveOutputPath } from "./files.js";

const rootEnvPath = path.resolve(process.cwd(), ".env");
const schemaPath = path.resolve(process.cwd(), "backend", "sql", "mysql_persistence_schema.sql");

let pool = null;
let tunnelProcess = null;
let startupState = {
  state: "idle",
  attemptedAt: null,
  connectedAt: null,
  error: "",
  tunnel: {
    required: false,
    active: false,
    localHost: "",
    localPort: null,
    remoteHost: "",
    remotePort: null,
    sshHost: "",
    sshPort: null,
  },
};

function loadRootEnvFile() {
  try {
    if (typeof process.loadEnvFile === "function" && fs.existsSync(rootEnvPath)) {
      process.loadEnvFile(rootEnvPath);
    }
  } catch {
    // Environment loading is best-effort; explicit process env wins.
  }
}

loadRootEnvFile();

function env(name, fallback = "") {
  return String(process.env[name] || fallback || "").trim();
}

function getConfiguredTimezone() {
  const selected = env("BLOSSOM_TIMEZONE", "UTC") || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: selected }).format(new Date());
    return selected;
  } catch {
    return "UTC";
  }
}

function copyEnvAlias(alias, target) {
  const aliasValue = env(alias);
  if (!env(target) && aliasValue) {
    process.env[target] = aliasValue;
  }
}

function normalizeMysqlEnvironment() {
  copyEnvAlias("DB_HOST", "MYSQL_HOST");
  copyEnvAlias("DB_PORT", "MYSQL_PORT");
  copyEnvAlias("DB_NAME", "MYSQL_DATABASE");
  copyEnvAlias("DB_USER", "MYSQL_USER");
  copyEnvAlias("DB_PASSWORD", "MYSQL_PASSWORD");
  copyEnvAlias("MYSQL_DATABASE_USER", "MYSQL_USER");
  copyEnvAlias("MYSQL_DATABASE_PASS", "MYSQL_PASSWORD");
  copyEnvAlias("MYSQL_SSH_HOST", "SSH_HOST");
  copyEnvAlias("MYSQL_SSH_PORT", "SSH_PORT");
  copyEnvAlias("MYSQL_SSH_USER", "SSH_USER");
  copyEnvAlias("MYSQL_SSH_PASSWORD", "SSH_PASS");

  if (!env("MYSQL_DATABASE") && env("MYSQL_USER")) {
    process.env.MYSQL_DATABASE = env("MYSQL_USER");
  }

  const sshHost = env("SSH_HOST");
  const mysqlHost = env("MYSQL_HOST");
  const autoStartTunnel = env("AUTO_START_TUNNEL", "1").toLowerCase();
  const tunnelEnabled = ["1", "true", "yes", "on"].includes(autoStartTunnel);
  if (tunnelEnabled && sshHost && mysqlHost && sshHost === mysqlHost) {
    process.env.REMOTE_HOST = env("MYSQL_REMOTE_HOST", "127.0.0.1");
    process.env.REMOTE_PORT = env("MYSQL_REMOTE_PORT", env("MYSQL_PORT", "3306"));
    process.env.LOCAL_BIND = env("LOCAL_BIND", "127.0.0.1");
    process.env.LOCAL_PORT = env("LOCAL_PORT", "3307");
    process.env.MYSQL_HOST = env("LOCAL_BIND", "127.0.0.1");
    process.env.MYSQL_PORT = env("LOCAL_PORT", "3307");
  }

  if (!env("MYSQL_PORT")) process.env.MYSQL_PORT = env("LOCAL_PORT", "3306");
  if (!env("MYSQL_POOL_LIMIT")) process.env.MYSQL_POOL_LIMIT = "10";
  if (!env("SSH_PORT")) process.env.SSH_PORT = "22";
  if (!env("LOCAL_BIND")) process.env.LOCAL_BIND = "127.0.0.1";
  if (!env("LOCAL_PORT")) process.env.LOCAL_PORT = env("MYSQL_PORT", "3306");
  if (!env("REMOTE_HOST")) process.env.REMOTE_HOST = "127.0.0.1";
  if (!env("REMOTE_PORT")) process.env.REMOTE_PORT = "3306";
  if (!env("AUTO_START_TUNNEL")) process.env.AUTO_START_TUNNEL = "1";
}

normalizeMysqlEnvironment();

function normalizeOrderId(value) {
  return String(value || "").trim().replace(/\.0$/, "");
}

function parseJsonFile(relativePath, fallback = {}) {
  try {
    const absolutePath = resolveOutputPath(relativePath);
    if (!fs.existsSync(absolutePath)) return fallback;
    return JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function parseDateTime(value) {
  const source = String(value || "").trim();
  if (!source) return null;
  const localDateTimeMatch = source.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/);
  if (localDateTimeMatch) {
    return `${localDateTimeMatch[1]} ${localDateTimeMatch[2]}:00`;
  }
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function formatDateKeyInTimezone(value, timeZone = getConfiguredTimezone()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function formatDateTimeInTimezone(value, timeZone = getConfiguredTimezone()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(parsed);
}

function getProcessedTimestampExpression({ orderAlias = "o", funeralAlias = "fr" } = {}) {
  return `COALESCE(${orderAlias}.last_processed_at, ${funeralAlias}.created_at, ${orderAlias}.updated_at)`;
}

function formatTimeZoneLabel(timeZone = getConfiguredTimezone()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const offset = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  return `${offset} | ${timeZone}`;
}

function parseDateAndTime(dateValue, timeValue) {
  const dateText = String(dateValue || "").trim();
  const timeText = String(timeValue || "").trim();
  if (!dateText) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText) && /^\d{2}:\d{2}/.test(timeText)) {
    return `${dateText} ${timeText.slice(0, 5)}:00`;
  }
  return parseDateTime(`${dateText} ${timeText}`) || parseDateTime(dateText);
}

function firstDateTimeCandidate(row = {}, candidates = []) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const parsed = parseDateAndTime(row[candidate[0]], row[candidate[1]]);
      if (parsed) return parsed;
      continue;
    }
    const parsed = parseDateTime(row[candidate]);
    if (parsed) return parsed;
  }
  return null;
}

function toSqlStatus(value = "") {
  const normalized = normalizeStatusValue(value);
  if (normalized === "notfound") return "not_found";
  return normalized === "unknown" ? "pending" : normalized;
}

function toJson(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

function readRows(relativePath) {
  try {
    const content = readFileContent(relativePath, 0);
    return Array.isArray(content.parsed) ? content.parsed : [];
  } catch {
    return [];
  }
}

function listRelativeFiles(relativeDir, matcher = () => true) {
  try {
    const absoluteDir = resolveOutputPath(relativeDir);
    if (!fs.existsSync(absoluteDir)) return [];
    const outputsRoot = resolveOutputPath("");
    const found = [];
    const walk = (currentDir) => {
      fs.readdirSync(currentDir, { withFileTypes: true }).forEach((entry) => {
        const absolutePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(absolutePath);
          return;
        }
        if (!entry.isFile()) return;
        const relativePath = path.relative(outputsRoot, absolutePath).replaceAll("\\", "/");
        if (matcher(relativePath, entry.name)) {
          found.push(relativePath);
        }
      });
    };
    walk(absoluteDir);
    return found.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function stableImportRunUuid(relativePath) {
  return `import_${Buffer.from(relativePath).toString("hex").slice(0, 24)}`;
}

function createProgressBar(current, total, width = 24) {
  const safeTotal = Math.max(Number(total || 0), 1);
  const safeCurrent = Math.max(0, Math.min(Number(current || 0), safeTotal));
  const filled = Math.round((safeCurrent / safeTotal) * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

function createProgressReporter(label, total, { step = 25 } = {}) {
  const safeTotal = Math.max(Number(total || 0), 0);
  if (safeTotal === 0) {
    console.log(`[mysql-import] ${label}: no items`);
    return { tick() {}, finish() {} };
  }
  let current = 0;
  let lastPrinted = -1;
  const print = (force = false) => {
    if (!force && current !== safeTotal && current - lastPrinted < step) return;
    lastPrinted = current;
    const percent = ((current / safeTotal) * 100).toFixed(1);
    console.log(`[mysql-import] ${label} ${createProgressBar(current, safeTotal)} ${current}/${safeTotal} (${percent}%)`);
  };
  print(true);
  return {
    tick(increment = 1) {
      current = Math.min(safeTotal, current + Math.max(1, Number(increment || 1)));
      print(false);
    },
    finish() {
      current = safeTotal;
      print(true);
    },
  };
}

function stableStringify(value) {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function createHash(value) {
  return crypto.createHash("sha1").update(String(value || ""), "utf-8").digest("hex");
}

function dedupeRowsByOrderId(rows = []) {
  const uniqueRows = [];
  const duplicateOrderIds = [];
  const missingOrderIdRows = [];
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const orderId = normalizeOrderId(row?.order_id || row?.ord_id || row?.orderId);
    if (!orderId) {
      missingOrderIdRows.push(row);
      continue;
    }
    if (seen.has(orderId)) {
      duplicateOrderIds.push(orderId);
      continue;
    }
    seen.add(orderId);
    uniqueRows.push({ ...row, order_id: orderId });
  }

  return {
    rows: uniqueRows,
    duplicateOrderIds,
    missingOrderIdRows,
  };
}

function prepareRowsForSync(rows = []) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const deduped = dedupeRowsByOrderId(sourceRows);
  return {
    rows: deduped.rows,
    sourceRowCount: sourceRows.length,
    syncableRowCount: deduped.rows.length,
    duplicateRowsSkipped: deduped.duplicateOrderIds.length,
    duplicateOrderIds: deduped.duplicateOrderIds,
    missingOrderIdRowsSkipped: deduped.missingOrderIdRows.length,
    missingOrderIdRows: deduped.missingOrderIdRows,
  };
}

async function fetchExistingOrderIds(currentPool, orderIds = []) {
  const normalizedOrderIds = Array.from(
    new Set((Array.isArray(orderIds) ? orderIds : []).map((item) => normalizeOrderId(item)).filter(Boolean)),
  );
  const existing = new Set();
  const chunkSize = 500;

  for (let index = 0; index < normalizedOrderIds.length; index += chunkSize) {
    const chunk = normalizedOrderIds.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const [rows] = await queryMysql(
      `SELECT order_id FROM orders WHERE deleted_at IS NULL AND order_id IN (${placeholders})`,
      chunk,
      "fetch existing order ids",
    );
    for (const row of rows || []) {
      const orderId = normalizeOrderId(row?.order_id);
      if (orderId) {
        existing.add(orderId);
      }
    }
  }

  return existing;
}

async function createSyncDatasetSummary(currentPool, rows = [], label = "") {
  const prepared = prepareRowsForSync(rows);
  const existingOrderIds = await fetchExistingOrderIds(
    currentPool,
    prepared.rows.map((row) => row.order_id),
  );
  return {
    label,
    sourceRows: prepared.sourceRowCount,
    syncableRows: prepared.syncableRowCount,
    duplicateRowsSkipped: prepared.duplicateRowsSkipped,
    missingOrderIdRowsSkipped: prepared.missingOrderIdRowsSkipped,
    existingOrderIdsInSql: existingOrderIds.size,
    newOrderIdsForSql: Math.max(0, prepared.syncableRowCount - existingOrderIds.size),
    rows: prepared.rows,
    duplicateOrderIds: prepared.duplicateOrderIds,
    missingOrderIdRows: prepared.missingOrderIdRows,
  };
}

function filterRowsByOrderIds(rows = [], orderIds = []) {
  const allowed = new Set((Array.isArray(orderIds) ? orderIds : []).map((item) => normalizeOrderId(item)).filter(Boolean));
  if (allowed.size === 0) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => allowed.has(normalizeOrderId(row?.order_id || row?.ord_id || row?.orderId)));
}

function filterPayloadMapByOrderIds(payloadMap = {}, orderIds = []) {
  const allowed = new Set((Array.isArray(orderIds) ? orderIds : []).map((item) => normalizeOrderId(item)).filter(Boolean));
  if (allowed.size === 0) return payloadMap || {};
  return Object.fromEntries(
    Object.entries(payloadMap || {}).filter(([key, payload]) => {
      const orderId = normalizeOrderId(key || payload?.order_id);
      return allowed.has(orderId);
    }),
  );
}

function mapScriptIdToSqlScriptName(scriptId = "") {
  return String(scriptId || "").trim().toLowerCase();
}

function mapScriptIdToOutputDir(scriptId = "") {
  switch (mapScriptIdToSqlScriptName(scriptId)) {
    case "get-task":
      return "GetTask";
    case "get-order-inquiry":
      return "GetOrderInquiry";
    case "funeral-finder":
    case "reverify":
      return "Funeral_Finder";
    case "updater":
      return "Updater";
    case "closing-task":
      return "ClosingTask";
    default:
      return "";
  }
}

function mapScriptIdToLogsFile(scriptId = "") {
  switch (mapScriptIdToSqlScriptName(scriptId)) {
    case "get-task":
      return "GetTask/logs.txt";
    case "get-order-inquiry":
      return "GetOrderInquiry/logs.txt";
    case "funeral-finder":
      return "Funeral_Finder/logs.txt";
    case "reverify":
      return "Funeral_Finder/reverify_logs.txt";
    case "updater":
      return "Updater/logs.txt";
    case "closing-task":
      return "ClosingTask/logs.txt";
    default:
      return "";
  }
}

function isMysqlSyncDebugEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.MYSQL_SYNC_DEBUG || "").trim());
}

function mysqlSyncDebug(message) {
  if (isMysqlSyncDebugEnabled()) {
    console.log(`[mysql-sync-debug] ${message}`);
  }
}

function shouldSyncGenericOutputFile(relativePath = "") {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  if (!normalized) return false;
  if (/\.(txt|xlsx)$/i.test(normalized)) return false;
  if (/(^|\/)(stats|query)\.json$/i.test(normalized)) return false;
  if (/(^|\/)(query|logs?|processed.*)\.txt$/i.test(normalized)) return false;
  if (/(^|\/)data\.csv$/i.test(normalized)) return false;
  if (/Funeral_Finder\/Funeral_data(_found|_customer|_not_found|_review)?\.csv$/i.test(normalized)) return false;
  if (/Funeral_Finder\/date_wise\/.*\.csv$/i.test(normalized)) return false;
  if (/(^|\/)(payload|reverify_payload)\.json$/i.test(normalized)) return false;
  return true;
}

function normalizeLogLine(line = "") {
  return String(line || "").replace(/^\[[^\]]+\]\s*/, "").trim();
}

const REQUIRED_MYSQL_ENV_KEYS = ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];

export function getMissingMysqlEnvKeys() {
  return REQUIRED_MYSQL_ENV_KEYS.filter((key) => !env(key));
}

export function getMysqlConfigurationSnapshot() {
  const missing = getMissingMysqlEnvKeys();
  const mysqlHost = env("MYSQL_HOST");
  const mysqlPort = Number(env("MYSQL_PORT", "3306")) || 3306;
  const sshHost = env("SSH_HOST");
  const sshUser = env("SSH_USER");
  const tunnelExpected = Boolean(sshHost) && ["127.0.0.1", "localhost"].includes(mysqlHost);
  return {
    configured: missing.length === 0,
    missing,
    values: {
      MYSQL_HOST: mysqlHost || "",
      MYSQL_PORT: mysqlPort,
      MYSQL_DATABASE: env("MYSQL_DATABASE") || "",
      MYSQL_USER: env("MYSQL_USER") || "",
      SSH_HOST: sshHost || "",
      SSH_PORT: Number(env("SSH_PORT", "22")) || 22,
      SSH_USER: sshUser || "",
      LOCAL_BIND: env("LOCAL_BIND") || "",
      LOCAL_PORT: Number(env("LOCAL_PORT", env("MYSQL_PORT", "3306"))) || mysqlPort,
      REMOTE_HOST: env("REMOTE_HOST") || "",
      REMOTE_PORT: Number(env("REMOTE_PORT", "3306")) || 3306,
      AUTO_START_TUNNEL: env("AUTO_START_TUNNEL", "1") || "1",
    },
    tunnelExpected,
    tunnelCredentialsConfigured: Boolean(sshHost && sshUser),
  };
}

export function buildMysqlConnectionGuidance() {
  const snapshot = getMysqlConfigurationSnapshot();
  if (!snapshot.configured) {
    return {
      summary: "MySQL env is incomplete on this server.",
      steps: [
        `Fill these .env keys on the server: ${snapshot.missing.join(", ")}`,
        "Restart the backend after saving .env so the Node process reloads MySQL settings.",
        "If Scripts use their own env, copy the same file into Scripts/.env as well.",
      ],
    };
  }

  if (snapshot.tunnelExpected && !snapshot.tunnelCredentialsConfigured) {
    return {
      summary: "MySQL appears to require an SSH tunnel, but SSH credentials are incomplete.",
      steps: [
        "Set SSH_HOST and SSH_USER in .env for tunnel startup, or change MYSQL_HOST to a directly reachable database host.",
        "If you rely on local forwarding, keep MYSQL_HOST=127.0.0.1 and MYSQL_PORT equal to the forwarded local port.",
        "Restart the backend and recheck SQL health.",
      ],
    };
  }

  if (["127.0.0.1", "localhost"].includes(String(snapshot.values.MYSQL_HOST || "")) && !snapshot.values.SSH_HOST) {
    return {
      summary: "The backend is pointing to localhost for MySQL. That only works if MySQL is running on the same server or a local tunnel is open.",
      steps: [
        "If your SQL server is on another machine, replace MYSQL_HOST=localhost with the real database host or IP.",
        "If you intended to use SSH forwarding, keep MYSQL_HOST=127.0.0.1 and add SSH_HOST, SSH_USER, SSH_PASS, and the local/remote tunnel ports.",
        "Restart PM2 after updating .env, then recheck SQL health.",
      ],
    };
  }

  return {
    summary: "MySQL env is present. If connection still fails, verify host reachability, credentials, database name, direct local MySQL availability on 127.0.0.1:3306, and tunnel availability.",
    steps: [
      "Check backend startup logs for the exact MySQL or SSH tunnel error.",
      "If this app is running on the same server as MySQL, prefer 127.0.0.1:3306 over a tunnel.",
      "Confirm the database server accepts connections from the app server or from the configured SSH tunnel target.",
      "If this is a Cloudways-hosted app, update .env on the server and restart PM2 after every SQL config change.",
    ],
  };
}

export function getMysqlConfig() {
  return {
    host: env("MYSQL_HOST"),
    port: Number(env("MYSQL_PORT", "3306")) || 3306,
    user: env("MYSQL_USER"),
    password: env("MYSQL_PASSWORD"),
    database: env("MYSQL_DATABASE"),
    connectionLimit: Number(env("MYSQL_POOL_LIMIT", "10")) || 10,
    multipleStatements: true,
    charset: "utf8mb4",
    supportBigNumbers: true,
  };
}

function currentTunnelDetails() {
  const mysqlHost = env("MYSQL_HOST");
  const mysqlPort = Number(env("MYSQL_PORT", "3306")) || 3306;
  const localHost = env("LOCAL_BIND", mysqlHost || "127.0.0.1");
  const localPort = Number(env("LOCAL_PORT", String(mysqlPort))) || mysqlPort;
  const sshHost = env("SSH_HOST");
  return {
    required: Boolean(sshHost) && (mysqlHost === "127.0.0.1" || mysqlHost === "localhost"),
    active: Boolean(tunnelProcess && tunnelProcess.exitCode == null),
    localHost,
    localPort,
    remoteHost: env("REMOTE_HOST", "127.0.0.1"),
    remotePort: Number(env("REMOTE_PORT", "3306")) || 3306,
    sshHost,
    sshPort: Number(env("SSH_PORT", "22")) || 22,
  };
}

function setStartupState(nextState = {}) {
  startupState = {
    ...startupState,
    ...nextState,
    tunnel: {
      ...startupState.tunnel,
      ...currentTunnelDetails(),
      ...(nextState.tunnel || {}),
    },
  };
}

function isTcpOpen(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finalize = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", () => finalize(false));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activateLocalMysqlTunnelTarget() {
  const localBind = env("LOCAL_BIND", "127.0.0.1");
  const localPort = env("LOCAL_PORT", "3307");
  process.env.MYSQL_HOST = localBind;
  process.env.MYSQL_PORT = localPort;
  if (!env("REMOTE_HOST")) process.env.REMOTE_HOST = "127.0.0.1";
  if (!env("REMOTE_PORT")) process.env.REMOTE_PORT = "3306";
}

async function tryDefaultLocalMysqlFallback() {
  const fallbackHost = env("MYSQL_DIRECT_HOST", "127.0.0.1");
  const fallbackPort = Number(env("MYSQL_DIRECT_PORT", "3306")) || 3306;
  const currentHost = env("MYSQL_HOST");
  const currentPort = Number(env("MYSQL_PORT", "3306")) || 3306;
  if (currentHost === fallbackHost && currentPort === fallbackPort) {
    return false;
  }
  if (!await isTcpOpen(fallbackHost, fallbackPort, 1200)) {
    return false;
  }
  process.env.MYSQL_HOST = fallbackHost;
  process.env.MYSQL_PORT = String(fallbackPort);
  setStartupState({
    state: "initializing",
    error: "",
    tunnel: { active: false, required: false },
  });
  await closeMysqlPool();
  return true;
}

async function tryDirectLocalMysqlFallback() {
  const host = env("MYSQL_HOST");
  const port = Number(env("MYSQL_PORT", "3306")) || 3306;
  const remoteHost = env("REMOTE_HOST", "127.0.0.1");
  const remotePort = Number(env("REMOTE_PORT", "3306")) || 3306;
  if (
    ["127.0.0.1", "localhost"].includes(host)
    && port !== remotePort
    && ["127.0.0.1", "localhost"].includes(remoteHost)
    && await isTcpOpen(remoteHost, remotePort, 1200)
  ) {
    process.env.MYSQL_HOST = remoteHost;
    process.env.MYSQL_PORT = String(remotePort);
    setStartupState({
      state: "initializing",
      error: "",
      tunnel: { active: false, required: false },
    });
    await closeMysqlPool();
    return true;
  }
  return false;
}

function buildSshCommand() {
  const sshProgram = process.platform === "win32" ? "ssh.exe" : "ssh";
  const localBind = env("LOCAL_BIND", "127.0.0.1");
  const localPort = env("LOCAL_PORT", env("MYSQL_PORT", "3306"));
  const remoteHost = env("REMOTE_HOST", "127.0.0.1");
  const remotePort = env("REMOTE_PORT", "3306");
  const sshPort = env("SSH_PORT", "22");
  const sshUser = env("SSH_USER");
  const sshHost = env("SSH_HOST");
  if (!sshUser || !sshHost) {
    throw new Error("SSH_USER and SSH_HOST are required to start the MySQL tunnel.");
  }
  const baseArgs = [
    "-N",
    "-L",
    `${localBind}:${localPort}:${remoteHost}:${remotePort}`,
    "-p",
    sshPort,
    "-o",
    "ServerAliveInterval=60",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    process.platform === "win32" ? "UserKnownHostsFile=NUL" : "UserKnownHostsFile=/dev/null",
    `${sshUser}@${sshHost}`,
  ];
  const sshPass = env("SSH_PASS");
  if (process.platform !== "win32" && sshPass) {
    return {
      program: "sshpass",
      args: ["-p", sshPass, sshProgram, ...baseArgs],
    };
  }
  return {
    program: sshProgram,
    args: baseArgs,
  };
}

async function ensureMysqlTunnelReady() {
  const host = env("MYSQL_HOST");
  const port = Number(env("MYSQL_PORT", "3306")) || 3306;
  if (!host) return;
  if (await isTcpOpen(host, port, 1200)) {
    setStartupState({ tunnel: { active: Boolean(tunnelProcess && tunnelProcess.exitCode == null) } });
    return;
  }

  if (await tryDefaultLocalMysqlFallback()) {
    return;
  }

  const remoteHost = env("REMOTE_HOST", "127.0.0.1");
  const remotePort = Number(env("REMOTE_PORT", "3306")) || 3306;
  if (await tryDirectLocalMysqlFallback()) {
    return;
  }

  if (!["127.0.0.1", "localhost"].includes(host)) {
    if (env("SSH_HOST")) {
      activateLocalMysqlTunnelTarget();
      return ensureMysqlTunnelReady();
    }
    throw new Error(`MySQL host is not reachable at ${host}:${port}. Configure MYSQL_HOST=127.0.0.1 with the SSH tunnel port.`);
  }

  if (!["1", "true", "yes", "on"].includes(env("AUTO_START_TUNNEL", "1").toLowerCase())) {
    throw new Error(`MySQL tunnel is not open at ${host}:${port} and AUTO_START_TUNNEL is disabled.`);
  }

  if (tunnelProcess && tunnelProcess.exitCode == null) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await isTcpOpen(host, port, 1200)) {
        setStartupState({ tunnel: { active: true } });
        return;
      }
      await wait(1000);
    }
    throw new Error(`SSH tunnel is running but ${host}:${port} never became reachable.`);
  }

  const sshPass = env("SSH_PASS");
  if (process.platform === "win32" && !sshPass) {
    const { program, args } = buildSshCommand();
    throw new Error(`SSH tunnel is closed and SSH_PASS is missing. Start it manually with: ${program} ${args.join(" ")}`);
  }

  const { program, args } = buildSshCommand();
  const childEnv = { ...process.env };
  let askpassPath = "";
  if (process.platform === "win32" && sshPass) {
    askpassPath = path.join(process.cwd(), ".tmp-blossom-ssh-askpass.cmd");
    fs.writeFileSync(askpassPath, `@echo off\r\necho ${sshPass}\r\n`, "utf-8");
    childEnv.SSH_ASKPASS = askpassPath;
    childEnv.SSH_ASKPASS_REQUIRE = "force";
    childEnv.DISPLAY = childEnv.DISPLAY || "blossom";
  }

  const child = spawn(program, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.unref();
  child.stderr?.unref?.();
  tunnelProcess = child;
  let stderrOutput = "";
  let launchError = null;
  child.once("error", (error) => {
    launchError = error;
  });
  child.stderr?.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (launchError) {
      if (askpassPath && fs.existsSync(askpassPath)) {
        fs.unlinkSync(askpassPath);
      }
      throw new Error(`SSH tunnel failed to start: ${launchError.message}`);
    }
    if (await isTcpOpen(host, port, 1200)) {
      setStartupState({ tunnel: { active: true } });
      if (askpassPath && fs.existsSync(askpassPath)) {
        fs.unlinkSync(askpassPath);
      }
      return;
    }
    if (child.exitCode != null) {
      if (askpassPath && fs.existsSync(askpassPath)) {
        fs.unlinkSync(askpassPath);
      }
      throw new Error(`SSH tunnel process exited early with code ${child.exitCode}.${stderrOutput ? ` ${stderrOutput.trim()}` : ""}`);
    }
    await wait(1000);
  }

  if (askpassPath && fs.existsSync(askpassPath)) {
    fs.unlinkSync(askpassPath);
  }
  throw new Error(`SSH tunnel did not become ready at ${host}:${port} within 20 seconds.`);
}

export function getMysqlStartupStatus() {
  return {
    ...startupState,
    tunnel: currentTunnelDetails(),
  };
}

export async function initializeMysqlRuntime({ ensureSchema = true } = {}) {
  normalizeMysqlEnvironment();
  setStartupState({
    state: "initializing",
    attemptedAt: new Date().toISOString(),
    connectedAt: null,
    error: "",
  });
  if (!isMysqlConfigured()) {
    setStartupState({
      state: "failed",
      error: "MySQL is not configured. Set MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE in .env.",
    });
    return getMysqlStartupStatus();
  }
  try {
    await ensureMysqlTunnelReady();
    const connection = await testMysqlConnection();
    if (ensureSchema) {
      await ensureMysqlSchema();
    }
    setStartupState({
      state: "connected",
      connectedAt: new Date().toISOString(),
      error: "",
    });
    return { ...getMysqlStartupStatus(), connection };
  } catch (error) {
    setStartupState({
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function isMysqlConfigured() {
  return getMissingMysqlEnvKeys().length === 0;
}

export async function getMysqlPool() {
  if (!isMysqlConfigured()) {
    throw new Error("MySQL is not configured. Set MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE in .env.");
  }
  if (!pool) {
    pool = mysql.createPool({
      ...getMysqlConfig(),
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
  }
  return pool;
}

export async function closeMysqlPool() {
  if (!pool) return;
  const existingPool = pool;
  pool = null;
  try {
    await existingPool.end();
  } catch {
    // Best-effort cleanup before creating a fresh pool.
  }
}

function isRetryableMysqlError(error) {
  const code = String(error?.code || "").toUpperCase();
  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "PROTOCOL_CONNECTION_LOST",
    "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
    "PROTOCOL_ENQUEUE_AFTER_QUIT",
  ].includes(code);
}

async function withMysqlRetry(callback, label = "mysql operation", { attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const activePool = await getMysqlPool();
      return await callback(activePool, attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableMysqlError(error) || attempt >= attempts) {
        setStartupState({
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      console.warn(`[mysql] ${label} failed with ${error.code || "UNKNOWN"} on attempt ${attempt}/${attempts}; retrying with a fresh pool`);
      await closeMysqlPool();
      await tryDirectLocalMysqlFallback();
      await ensureMysqlTunnelReady();
      await wait(500 * attempt);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

async function queryMysql(sql, params = [], label = "mysql query") {
  return withMysqlRetry((activePool) => activePool.query(sql, params), label);
}

async function executeMysql(sql, params = [], label = "mysql execute") {
  return withMysqlRetry((activePool) => activePool.execute(sql, params), label);
}

export async function testMysqlConnection() {
  const [rows] = await queryMysql("SELECT DATABASE() AS database_name, NOW() AS server_time", [], "test mysql connection");
  return rows?.[0] || null;
}

export async function ensureMysqlSchema() {
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await queryMysql(sql, [], "ensure mysql schema");
  await runMysqlSchemaMigrations();
  return { ok: true };
}

async function runMysqlSchemaMigrations() {
  const migrations = [
    "ALTER TABLE order_processing_state MODIFY last_run_uuid VARCHAR(100) NULL",
  ];
  for (const migration of migrations) {
    await executeMysql(migration, [], "mysql schema migration");
  }
  const optionalIndexMigrations = [
    "ALTER TABLE order_processing_state ADD INDEX idx_order_processing_state_script_status_updated (script_name, status, updated_at, order_id)",
    "ALTER TABLE funeral_results ADD INDEX idx_funeral_results_current_created (order_id, is_current, created_at, match_status)",
  ];
  for (const migration of optionalIndexMigrations) {
    try {
      await executeMysql(migration, [], "mysql schema index migration");
    } catch (error) {
      const code = String(error?.code || "");
      const message = String(error?.message || "");
      if (code === "ER_DUP_KEYNAME" || /duplicate key name/i.test(message)) {
        continue;
      }
      throw error;
    }
  }
}

export async function resetBlossomMysqlTables() {
  const tables = [
    "audit_events",
    "reports",
    "script_log_sync_entries",
    "script_output_sync_rows",
    "script_output_sync_files",
    "script_run_logs",
    "ai_attempts",
    "crm_update_attempts",
    "funeral_results",
    "order_inquiries",
    "order_processing_state",
    "script_runs",
    "orders",
  ];
  await queryMysql("SET FOREIGN_KEY_CHECKS=0", [], "disable foreign key checks");
  try {
    for (const table of tables) {
      await queryMysql(`TRUNCATE TABLE ${table}`, [], `truncate ${table}`);
    }
  } finally {
    await queryMysql("SET FOREIGN_KEY_CHECKS=1", [], "enable foreign key checks");
  }
  return { ok: true, tables };
}

async function upsertOrder(currentPool, row = {}, explicitStatus = "") {
  const orderId = normalizeOrderId(row.order_id || row.ord_id || row.orderId);
  if (!orderId) return null;
  const latestStatus = toSqlStatus(explicitStatus || row.match_status || row.status || row.trResult || row.source_status);
  await executeMysql(
    `
      INSERT INTO orders (
        order_id, task_id, ship_name, ship_city, ship_state, ship_zip,
        ship_care_of, ship_address, ord_instruct, latest_status, source_status, last_processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        task_id = COALESCE(VALUES(task_id), task_id),
        ship_name = COALESCE(NULLIF(VALUES(ship_name), ''), ship_name),
        ship_city = COALESCE(NULLIF(VALUES(ship_city), ''), ship_city),
        ship_state = COALESCE(NULLIF(VALUES(ship_state), ''), ship_state),
        ship_zip = COALESCE(NULLIF(VALUES(ship_zip), ''), ship_zip),
        ship_care_of = COALESCE(NULLIF(VALUES(ship_care_of), ''), ship_care_of),
        ship_address = COALESCE(NULLIF(VALUES(ship_address), ''), ship_address),
        ord_instruct = COALESCE(NULLIF(VALUES(ord_instruct), ''), ord_instruct),
        latest_status = CASE
          WHEN VALUES(latest_status) <> 'unknown' THEN VALUES(latest_status)
          ELSE latest_status
        END,
        source_status = COALESCE(NULLIF(VALUES(source_status), ''), source_status),
        last_processed_at = COALESCE(VALUES(last_processed_at), last_processed_at),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      orderId,
      row.task_id || null,
      row.ship_name || null,
      row.ship_city || null,
      row.ship_state || null,
      row.ship_zip || null,
      row.ship_care_of || null,
      row.ship_address || null,
      row.ord_instruct || null,
      latestStatus,
      row.source_status || row.status || null,
      parseDateTime(row.last_processed_at || row.processed_at || row.processedAt),
    ],
    "upsert order",
  );
  return orderId;
}

async function importGetTaskRows(currentPool, rows = [], progress = null) {
  for (const row of rows) {
    const orderId = await upsertOrder(currentPool, row, row.source_status || row.status);
    if (!orderId) continue;
    await executeMysql(
      `
        INSERT INTO order_processing_state (order_id, script_name, status, attempt_count, updated_at)
        VALUES (?, 'get-task', 'success', 1, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          status = 'success',
          attempt_count = attempt_count + 1,
          updated_at = CURRENT_TIMESTAMP
      `,
      [orderId],
      "import get-task order_processing_state",
    );
    progress?.tick();
  }
  progress?.finish();
}

async function importOrderInquiryRows(currentPool, rows = [], payloadMap = {}, progress = null) {
  for (const row of rows) {
    const orderId = await upsertOrder(currentPool, row, row.source_status || row.status);
    if (!orderId) continue;
    await executeMysql(
      `
        INSERT INTO order_inquiries (
          order_id, task_id, ord_date, delivery_date, ship_snapshot_json, itemlist_json, raw_payload_json, source_file, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        orderId,
        row.task_id || null,
        row.ord_date || null,
        row.delivery_date || null,
        toJson({
          ship_name: row.ship_name || null,
          ship_city: row.ship_city || null,
          ship_state: row.ship_state || null,
          ship_zip: row.ship_zip || null,
          ship_address: row.ship_address || null,
          ship_care_of: row.ship_care_of || null,
        }),
        toJson(row.itemlist || row.itemlist_json || null),
        toJson(payloadMap[orderId] || row),
        "GetOrderInquiry/data.csv",
        parseDateTime(row.last_processed_at || row.processed_at || row.processedAt),
      ],
      "import order inquiry row",
    );
    await executeMysql(
      `
        INSERT INTO order_processing_state (order_id, script_name, status, attempt_count, updated_at)
        VALUES (?, 'get-order-inquiry', 'success', 1, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          status = 'success',
          attempt_count = attempt_count + 1,
          updated_at = CURRENT_TIMESTAMP
      `,
      [orderId],
      "import get-order-inquiry order_processing_state",
    );
    progress?.tick();
  }
  progress?.finish();
}

async function importFuneralRows(currentPool, rows = [], payloadMap = {}, resultType = "original", options = {}, progress = null) {
  const isCurrent = options.isCurrent !== false;
  const markProcessing = options.markProcessing !== false;
  const sourceFile = options.sourceFile || "";
  for (const row of rows) {
    const orderId = await upsertOrder(currentPool, row, row.match_status || getRowStatus(row));
    if (!orderId) continue;
    const normalizedStatus = normalizeStatusValue(row.match_status || row.status || row.trResult);
    if (isCurrent) {
      await executeMysql("UPDATE funeral_results SET is_current = 0 WHERE order_id = ?", [orderId], "clear current funeral results");
    }
    await executeMysql(
      `
        INSERT INTO funeral_results (
          order_id, result_type, match_status, service_datetime, funeral_home, address,
          phone, source_urls, raw_result_json, ai_accuracy_score, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        orderId,
        resultType,
        normalizedStatus === "notfound" ? "NotFound" :
          normalizedStatus === "review" ? "Review" :
          normalizedStatus === "customer" ? "Customer" :
          normalizedStatus === "found" ? "Found" : "Unknown",
        firstDateTimeCandidate(row, [
          "service_datetime",
          ["service_date", "service_time"],
          ["visitation_date", "visitation_time"],
          ["delivery_recommendation_date", "delivery_recommendation_time"],
          ["ceremony_date", "ceremony_time"],
          "delivery_date",
          "last_processed_at",
        ]),
        row.funeral_home || row.funeral_home_name || row.venue_name || null,
        row.address || row.funeral_home_address || null,
        row.phone || null,
        toJson(row.source_urls || row.urls || null),
        toJson(payloadMap[orderId] || (sourceFile ? { ...row, source_file: sourceFile } : row)),
        row.ai_accuracy_score ? Number(row.ai_accuracy_score) : null,
        isCurrent ? 1 : 0,
      ],
      "import funeral row",
    );
    if (!markProcessing) {
      continue;
    }
    await executeMysql(
      `
        INSERT INTO order_processing_state (order_id, script_name, status, attempt_count, updated_at)
        VALUES (?, 'funeral-finder', 'success', 1, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          status = 'success',
          attempt_count = attempt_count + 1,
          updated_at = CURRENT_TIMESTAMP
      `,
      [orderId],
      "import funeral-finder order_processing_state",
    );
    progress?.tick();
  }
  progress?.finish();
}

async function importFuneralStatusBuckets(currentPool, payloadMap = {}, progress = null) {
  const files = [
    "Funeral_Finder/Funeral_data_found.csv",
    "Funeral_Finder/Funeral_data_customer.csv",
    "Funeral_Finder/Funeral_data_not_found.csv",
    "Funeral_Finder/Funeral_data_review.csv",
  ];
  let count = 0;
  for (const file of files) {
    const rows = dedupeRowsByOrderId(readRows(file)).rows;
    count += rows.length;
    await importFuneralRows(currentPool, rows, payloadMap, "imported", { isCurrent: true, sourceFile: file }, progress);
  }
  progress?.finish();
  return count;
}

async function importDateWiseFuneralRows(currentPool, progress = null) {
  const files = listRelativeFiles(
    "Funeral_Finder/date_wise",
    (relativePath, name) => /^Funeral_data.*\.csv$/i.test(name) && relativePath.includes("/date_wise/"),
  );
  let count = 0;
  for (const file of files) {
    const rows = dedupeRowsByOrderId(readRows(file)).rows;
    count += rows.length;
    await importFuneralRows(currentPool, rows, {}, "imported", {
      isCurrent: false,
      markProcessing: false,
      sourceFile: file,
    }, progress);
  }
  progress?.finish();
  return { files: files.length, rows: count };
}

async function importAiAttempts(currentPool, payloadMap = {}, { provider = "", modelName = "", strategy = "" } = {}, progress = null) {
  let count = 0;
  for (const [rawOrderId, payload] of Object.entries(payloadMap || {})) {
    const orderId = normalizeOrderId(rawOrderId || payload?.order_id);
    if (!orderId) continue;
    await upsertOrder(currentPool, { order_id: orderId }, "pending");
    const attempts = Array.isArray(payload?.attempts) && payload.attempts.length > 0
      ? payload.attempts
      : [payload];
    for (const attempt of attempts) {
      await executeMysql(
        `
          INSERT INTO ai_attempts (
            order_id, provider, model_name, strategy, prompt_text, raw_response,
            parsed_json, status, error_message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          orderId,
          attempt?.provider || provider || null,
          attempt?.model || attempt?.model_name || modelName || null,
          attempt?.strategy || strategy || null,
          attempt?.prompt || attempt?.prompt_text || null,
          attempt?.raw_ai_response || attempt?.raw_response || attempt?.response || payload?.raw_ai_response || null,
          toJson(attempt?.parsed_result || attempt?.parsed_json || attempt?.result || payload?.parsed_result || payload?.result || null),
          String(attempt?.status || payload?.status || "success").toLowerCase().includes("fail") ? "failed" : "success",
          attempt?.error || attempt?.error_message || payload?.error || null,
          parseDateTime(attempt?.timestamp || payload?.timestamp) || new Date().toISOString().slice(0, 19).replace("T", " "),
        ],
        "import ai attempt",
      );
      count += 1;
      progress?.tick();
    }
  }
  progress?.finish();
  return count;
}

async function importScriptLogFile(currentPool, relativePath, scriptName) {
  const absolutePath = resolveOutputPath(relativePath);
  if (!fs.existsSync(absolutePath)) return 0;
  const raw = fs.readFileSync(absolutePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return 0;
  const runUuid = stableImportRunUuid(relativePath);
  await executeMysql(
    `
      INSERT INTO script_runs (
        run_uuid, script_name, run_mode, start_mode, status,
        summary_json, started_at, finished_at
      ) VALUES (?, ?, 'import', 'full', 'success', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        summary_json = VALUES(summary_json),
        finished_at = CURRENT_TIMESTAMP,
        status = 'success'
    `,
    [runUuid, scriptName, toJson({ source_file: relativePath, imported_lines: lines.length })],
    "import script log run",
  );
  await executeMysql("DELETE FROM script_run_logs WHERE run_uuid = ?", [runUuid], "clear imported script logs");
  for (const line of lines) {
    await executeMysql(
      `
        INSERT INTO script_run_logs (run_uuid, script_name, level, message)
        VALUES (?, ?, 'info', ?)
      `,
      [runUuid, scriptName, line],
      "import script log line",
    );
  }
  return lines.length;
}

async function importAllScriptLogs(currentPool) {
  const logSpecs = [
    { dir: "GetTask", scriptName: "get-task" },
    { dir: "GetOrderInquiry", scriptName: "get-order-inquiry" },
    { dir: "Funeral_Finder", scriptName: "funeral-finder" },
    { dir: "Updater", scriptName: "updater" },
    { dir: "ClosingTask", scriptName: "closing-task" },
  ];
  let files = 0;
  let lines = 0;
  for (const spec of logSpecs) {
    const logFiles = listRelativeFiles(spec.dir, (_relativePath, name) => /\.txt$/i.test(name) && /log|processed/i.test(name));
    for (const file of logFiles) {
      const importedLines = await importScriptLogFile(currentPool, file, spec.scriptName);
      if (importedLines > 0) {
        files += 1;
        lines += importedLines;
      }
    }
  }
  return { files, lines };
}

async function importCrmAttemptRows(currentPool, rows = [], attemptType = "updater", payloadMap = {}, progress = null) {
  for (const row of rows) {
    const orderId = await upsertOrder(currentPool, row, row.trResult || row.status);
    if (!orderId) continue;
    await executeMysql(
      `
        INSERT INTO crm_update_attempts (
          order_id, attempt_type, tr_result, tr_end_date, tr_text, request_json,
          response_json, response_code, upload_status, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        orderId,
        attemptType,
        row.trResult || row.match_status || null,
        parseDateTime(row.trEndDate || row.tr_end_date || row.last_processed_at),
        row.trText || row.notes || null,
        toJson(payloadMap[orderId]?.request || null),
        toJson(payloadMap[orderId]?.response || payloadMap[orderId] || null),
        row.response_status_code ? Number(row.response_status_code) : null,
        String(row.upload_status || "").trim().toLowerCase() === "success" ? "success" :
          String(row.upload_status || "").trim().toLowerCase() === "failed" ? "failed" :
          String(row.upload_status || "").trim().toLowerCase() === "skipped" ? "skipped" : "pending",
        row.error_message || null,
      ],
      "import crm attempt row",
    );
    await executeMysql(
      `
        INSERT INTO order_processing_state (order_id, script_name, status, attempt_count, updated_at)
        VALUES (?, ?, 'success', 1, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          status = 'success',
          attempt_count = attempt_count + 1,
          updated_at = CURRENT_TIMESTAMP
      `,
      [orderId, attemptType === "closing" ? "closing-task" : "updater"],
      "import crm order_processing_state",
    );
    progress?.tick();
  }
  progress?.finish();
}

async function recordFileSyncFingerprint(currentPool, {
  runUuid,
  scriptName,
  relativePath,
  contentHash,
  fileSize = null,
  rowCount = 0,
}) {
  const [result] = await executeMysql(
    `
      INSERT IGNORE INTO script_output_sync_files (
        run_uuid, script_name, relative_path, content_hash, file_size, row_count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [runUuid || null, scriptName, relativePath, contentHash, fileSize, rowCount],
    "record file sync fingerprint",
  );
  return Number(result?.affectedRows || 0) > 0;
}

async function recordRowSyncFingerprint(currentPool, {
  runUuid,
  scriptName,
  relativePath,
  orderId = null,
  rowHash,
  rowType = "record",
}) {
  const [result] = await executeMysql(
    `
      INSERT IGNORE INTO script_output_sync_rows (
        run_uuid, script_name, relative_path, order_id, row_hash, row_type
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [runUuid || null, scriptName, relativePath, orderId || null, rowHash, rowType],
    "record row sync fingerprint",
  );
  return Number(result?.affectedRows || 0) > 0;
}

async function recordLogSyncFingerprint(currentPool, {
  runUuid,
  scriptName,
  orderId = null,
  sourceType = "runtime",
  logHash,
}) {
  const [result] = await executeMysql(
    `
      INSERT IGNORE INTO script_log_sync_entries (
        run_uuid, script_name, order_id, source_type, log_hash
      ) VALUES (?, ?, ?, ?, ?)
    `,
    [runUuid, scriptName, orderId || null, sourceType, logHash],
    "record log sync fingerprint",
  );
  return Number(result?.affectedRows || 0) > 0;
}

async function upsertScriptRun(currentPool, {
  runUuid,
  scriptName,
  orderId = null,
  status = "success",
  runMode = "manual",
  startMode = "full",
  summaryJson = null,
  errorMessage = null,
}) {
  await executeMysql(
    `
      INSERT INTO script_runs (
        run_uuid, order_id, script_name, run_mode, start_mode, status,
        summary_json, error_message, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        order_id = COALESCE(VALUES(order_id), order_id),
        status = VALUES(status),
        summary_json = COALESCE(VALUES(summary_json), summary_json),
        error_message = VALUES(error_message),
        finished_at = CURRENT_TIMESTAMP
      `,
    [runUuid, orderId || null, scriptName, runMode, startMode, status, toJson(summaryJson), errorMessage || null],
    "upsert script run",
  );
}

async function syncStructuredRows(currentPool, {
  runUuid,
  scriptName,
  relativePath,
  rows = [],
  rowType = "record",
  importer,
}) {
  const prepared = prepareRowsForSync(rows);
  const freshRows = [];
  for (const row of prepared.rows) {
    const orderId = normalizeOrderId(row?.order_id || row?.ord_id || row?.orderId);
    const rowHash = createHash(`${relativePath}:${stableStringify(row)}`);
    const inserted = await recordRowSyncFingerprint(currentPool, {
      runUuid,
      scriptName,
      relativePath,
      orderId: orderId || null,
      rowHash,
      rowType,
    });
    if (inserted) {
      freshRows.push(row);
    }
  }
  if (prepared.duplicateOrderIds.length > 0) {
    console.warn(`[mysql-sync] ${scriptName} ${relativePath}: skipped ${prepared.duplicateOrderIds.length} duplicate rows across ${new Set(prepared.duplicateOrderIds).size} order_id values`);
  }
  if (prepared.missingOrderIdRows.length > 0) {
    console.warn(`[mysql-sync] ${scriptName} ${relativePath}: skipped ${prepared.missingOrderIdRows.length} rows with missing order_id`);
  }
  if (freshRows.length > 0 && typeof importer === "function") {
    await importer(freshRows);
  }
  return freshRows.length;
}

async function syncGenericParsedFile(currentPool, {
  runUuid,
  scriptName,
  relativePath,
  sourceType = "file",
}) {
  const absolutePath = resolveOutputPath(relativePath);
  if (!fs.existsSync(absolutePath)) return { fileInserted: false, rowCount: 0 };
  const rawContent = fs.readFileSync(absolutePath);
  const contentHash = createHash(rawContent);
  let parsed;
  try {
    parsed = readFileContent(relativePath, 0);
  } catch {
    parsed = null;
  }
  const rowCount = Array.isArray(parsed?.parsed)
    ? parsed.parsed.length
    : Array.isArray(parsed?.parsed?.items)
      ? parsed.parsed.items.length
      : typeof parsed?.parsed === "string"
        ? 1
        : 0;
  const fileInserted = await recordFileSyncFingerprint(currentPool, {
    runUuid,
    scriptName,
    relativePath,
    contentHash,
    fileSize: rawContent.length,
    rowCount,
  });

  if (!parsed) {
    return { fileInserted, rowCount: 0 };
  }

  if (Array.isArray(parsed.parsed)) {
    let syncedRows = 0;
    for (const entry of parsed.parsed) {
      const isObject = entry && typeof entry === "object" && !Array.isArray(entry);
      const orderId = isObject ? normalizeOrderId(entry.order_id || entry.ord_id || entry.orderId) : null;
      const rowHash = createHash(`${relativePath}:${stableStringify(entry)}`);
      const inserted = await (sourceType === "file"
        ? recordRowSyncFingerprint(currentPool, {
            runUuid,
            scriptName,
            relativePath,
            orderId,
            rowHash,
            rowType: isObject ? "record" : "line",
          })
        : recordLogSyncFingerprint(currentPool, {
            runUuid,
            scriptName,
            orderId,
            sourceType,
            logHash: rowHash,
          }));
      if (inserted && sourceType === "file" && !isObject) {
        await currentPool.execute(
          "INSERT INTO script_run_logs (run_uuid, order_id, script_name, level, message) VALUES (?, ?, ?, 'info', ?)",
          [runUuid, orderId || null, scriptName, String(entry)],
        );
      }
      syncedRows += inserted ? 1 : 0;
    }
    return { fileInserted, rowCount: syncedRows };
  }

  return { fileInserted, rowCount: 0 };
}

export async function getSuccessfulOrderIdsForScript(scriptId, { limit = 20000 } = {}) {
  const currentPool = await getMysqlPool();
  const sqlScriptName = mapScriptIdToSqlScriptName(scriptId);
  const [rows] = await currentPool.query(
    `
      SELECT order_id
      FROM order_processing_state
      WHERE script_name = ? AND status = 'success'
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    [sqlScriptName, Math.max(1, Number(limit || 20000))],
  );
  return (rows || []).map((row) => normalizeOrderId(row.order_id)).filter(Boolean);
}

export async function ensureOrdersExist(rowsOrIds = []) {
  await ensureMysqlSchema();
  const currentPool = await getMysqlPool();
  const normalizedRows = [];
  const seen = new Set();

  for (const entry of Array.isArray(rowsOrIds) ? rowsOrIds : []) {
    const row = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry
      : { order_id: entry };
    const orderId = normalizeOrderId(row?.order_id || row?.ord_id || row?.orderId);
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    normalizedRows.push({ order_id: orderId });
  }

  if (normalizedRows.length === 0) {
    return { ensured: 0 };
  }

  const chunkSize = 250;
  let ensured = 0;
  for (let index = 0; index < normalizedRows.length; index += chunkSize) {
    const chunk = normalizedRows.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "(?)").join(", ");
    const values = chunk.map((row) => row.order_id);
    await currentPool.execute(
      `
        INSERT INTO orders (order_id)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          order_id = VALUES(order_id),
          updated_at = updated_at
      `,
      values,
    );
    ensured += chunk.length;
  }
  return { ensured };
}

export async function setOrderProcessingStateBulk({
  scriptName,
  status,
  orderRows = [],
  orderIds = [],
  lastRunUuid = null,
  incrementAttempt = false,
  errorByOrderId = {},
} = {}) {
  await ensureMysqlSchema();
  const normalizedScriptName = mapScriptIdToSqlScriptName(scriptName);
  const combinedRows = [];
  const seen = new Set();

  for (const row of Array.isArray(orderRows) ? orderRows : []) {
    const orderId = normalizeOrderId(row?.order_id || row?.ord_id || row?.orderId);
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    combinedRows.push({ ...row, order_id: orderId });
  }

  for (const rawOrderId of Array.isArray(orderIds) ? orderIds : []) {
    const orderId = normalizeOrderId(rawOrderId);
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    combinedRows.push({ order_id: orderId });
  }

  if (!normalizedScriptName || !status || combinedRows.length === 0) {
    return { updated: 0, scriptName: normalizedScriptName, status };
  }

  await ensureOrdersExist(combinedRows);
  const currentPool = await getMysqlPool();
  const chunkSize = 200;
  let updated = 0;

  for (let index = 0; index < combinedRows.length; index += chunkSize) {
    const chunk = combinedRows.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const values = [];

    chunk.forEach((row) => {
      const orderId = normalizeOrderId(row.order_id);
      values.push(
        orderId,
        normalizedScriptName,
        status,
        lastRunUuid,
        incrementAttempt ? 1 : 0,
        errorByOrderId?.[orderId] || null,
      );
    });

    await currentPool.execute(
      `
        INSERT INTO order_processing_state (
          order_id, script_name, status, last_run_uuid, attempt_count, last_error
        )
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          last_run_uuid = COALESCE(VALUES(last_run_uuid), last_run_uuid),
          attempt_count = CASE
            WHEN VALUES(attempt_count) > 0 THEN attempt_count + 1
            ELSE attempt_count
          END,
          last_error = VALUES(last_error),
          updated_at = CURRENT_TIMESTAMP
      `,
      values,
    );
    updated += chunk.length;
  }

  return { updated, scriptName: normalizedScriptName, status };
}

export async function hydrateScriptLogsFromSql(scriptId) {
  const relativeLogsPath = mapScriptIdToLogsFile(scriptId);
  if (!relativeLogsPath) return { ok: false, reason: "no-log-path" };
  const absolutePath = resolveOutputPath(relativeLogsPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const orderIds = await getSuccessfulOrderIdsForScript(scriptId);
  fs.writeFileSync(absolutePath, orderIds.length > 0 ? `${orderIds.join("\n")}\n` : "", "utf-8");
  return { ok: true, count: orderIds.length, relativePath: relativeLogsPath };
}

export async function persistRuntimeJobLogsToMysql({ runUuid, scriptId, logs = [], orderIds = [] }) {
  const currentPool = await getMysqlPool();
  const scriptName = mapScriptIdToSqlScriptName(scriptId);
  const primaryOrderId = Array.isArray(orderIds) && orderIds.length === 1 ? normalizeOrderId(orderIds[0]) : null;
  let inserted = 0;
  for (const rawLine of logs) {
    const message = normalizeLogLine(rawLine);
    if (!message) continue;
    const logHash = createHash(`runtime:${message}`);
    const canInsert = await recordLogSyncFingerprint(currentPool, {
      runUuid,
      scriptName,
      orderId: primaryOrderId,
      sourceType: "runtime",
      logHash,
    });
    if (!canInsert) continue;
    await currentPool.execute(
      `
        INSERT INTO script_run_logs (run_uuid, order_id, script_name, level, message)
        VALUES (?, ?, ?, ?, ?)
      `,
      [runUuid, primaryOrderId, scriptName, /error|failed|traceback/i.test(message) ? "error" : "info", message],
    );
    inserted += 1;
  }
  return { inserted };
}

export async function syncScriptOutputsToMysql({ runUuid, scriptId, orderIds = [], status = "success", errorMessage = null } = {}) {
  await ensureMysqlSchema();
  const currentPool = await getMysqlPool();
  const scriptName = mapScriptIdToSqlScriptName(scriptId);
  const outputDir = mapScriptIdToOutputDir(scriptId);
  if (!scriptName || !outputDir) {
    return { synced: false, reason: "unsupported-script", scriptId };
  }

  const scopedOrderIds = (Array.isArray(orderIds) ? orderIds : []).map((item) => normalizeOrderId(item)).filter(Boolean);
  const primaryOrderId = scopedOrderIds.length === 1 ? scopedOrderIds[0] : null;
  await upsertScriptRun(currentPool, {
    runUuid,
    scriptName,
    orderId: primaryOrderId,
    status,
    summaryJson: { scriptId, orderIds: scopedOrderIds },
    errorMessage,
  });

  const summary = {
    scriptId,
    runUuid,
    syncedFiles: 0,
    syncedRows: 0,
    runtimeLogs: 0,
  };

  const genericFiles = listRelativeFiles(outputDir).filter((relativePath) => shouldSyncGenericOutputFile(relativePath));
  mysqlSyncDebug(`${scriptId}: found ${genericFiles.length} generic files in ${outputDir}`);
  for (const relativePath of genericFiles) {
    mysqlSyncDebug(`${scriptId}: syncing generic file ${relativePath}`);
    const result = await syncGenericParsedFile(currentPool, {
      runUuid,
      scriptName,
      relativePath,
      sourceType: "file",
    });
    mysqlSyncDebug(`${scriptId}: generic file ${relativePath} synced files+rows ${result.fileInserted ? 1 : 0}/${result.rowCount}`);
    summary.syncedFiles += result.fileInserted ? 1 : 0;
    summary.syncedRows += result.rowCount;
  }

  if (scriptName === "get-task") {
    const getTaskRows = filterRowsByOrderIds(readRows("GetTask/data.csv"), scopedOrderIds);
    mysqlSyncDebug(`${scriptId}: structured GetTask rows ${getTaskRows.length}`);
    summary.syncedRows += await syncStructuredRows(currentPool, {
      runUuid,
      scriptName,
      relativePath: "GetTask/data.csv",
      rows: getTaskRows,
      importer: (freshRows) => importGetTaskRows(currentPool, freshRows),
    });
  } else if (scriptName === "get-order-inquiry") {
    const inquiryRows = filterRowsByOrderIds(readRows("GetOrderInquiry/data.csv"), scopedOrderIds);
    const payloadMap = filterPayloadMapByOrderIds(parseJsonFile("GetOrderInquiry/payload.json", {}), scopedOrderIds);
    mysqlSyncDebug(`${scriptId}: structured GetOrderInquiry rows ${inquiryRows.length}`);
    summary.syncedRows += await syncStructuredRows(currentPool, {
      runUuid,
      scriptName,
      relativePath: "GetOrderInquiry/data.csv",
      rows: inquiryRows,
      importer: (freshRows) => importOrderInquiryRows(currentPool, freshRows, payloadMap),
    });
  } else if (scriptName === "funeral-finder" || scriptName === "reverify") {
    const relativePath = "Funeral_Finder/Funeral_data.csv";
    const funeralRows = filterRowsByOrderIds(readRows(relativePath), scopedOrderIds);
    const payloadFile = scriptName === "reverify" ? "Funeral_Finder/reverify_payload.json" : "Funeral_Finder/payload.json";
    const payloadMap = filterPayloadMapByOrderIds(parseJsonFile(payloadFile, {}), scopedOrderIds);
    mysqlSyncDebug(`${scriptId}: structured funeral rows ${funeralRows.length}`);
    summary.syncedRows += await syncStructuredRows(currentPool, {
      runUuid,
      scriptName,
      relativePath,
      rows: funeralRows,
      importer: (freshRows) => importFuneralRows(currentPool, freshRows, payloadMap, scriptName === "reverify" ? "reverify" : "original"),
    });
    summary.syncedRows += await syncStructuredRows(currentPool, {
      runUuid,
      scriptName,
      relativePath: payloadFile,
      rows: Object.entries(payloadMap).map(([orderId, payload]) => ({ order_id: orderId, payload })),
      rowType: "ai-payload",
      importer: async (freshRows) => {
        const freshPayloadMap = Object.fromEntries(
          freshRows.map((row) => [normalizeOrderId(row.order_id), row.payload]).filter(([orderId]) => Boolean(orderId)),
        );
        await importAiAttempts(currentPool, freshPayloadMap, {
          provider: scriptName === "reverify" ? "mixed" : "openai",
          strategy: scriptName,
        });
      },
    });
  } else if (scriptName === "updater" || scriptName === "closing-task") {
    const relativePath = scriptName === "updater" ? "Updater/data.csv" : "ClosingTask/data.csv";
    const payloadPath = scriptName === "updater" ? "Updater/payload.json" : "ClosingTask/payload.json";
    const rows = filterRowsByOrderIds(readRows(relativePath), scopedOrderIds);
    const payloadMap = filterPayloadMapByOrderIds(parseJsonFile(payloadPath, {}), scopedOrderIds);
    mysqlSyncDebug(`${scriptId}: structured CRM rows ${rows.length}`);
    summary.syncedRows += await syncStructuredRows(currentPool, {
      runUuid,
      scriptName,
      relativePath,
      rows,
      importer: (freshRows) => importCrmAttemptRows(currentPool, freshRows, scriptName === "closing-task" ? "closing" : "updater", payloadMap),
    });
  }

  return summary;
}

export async function importOutputsToMysql({ ensureSchema = true } = {}) {
  if (ensureSchema) {
    await ensureMysqlSchema();
  }
  const currentPool = await getMysqlPool();
  const summary = {
    importedAt: new Date().toISOString(),
    orders: 0,
    getTaskRows: 0,
    orderInquiryRows: 0,
    funeralRows: 0,
    funeralStatusBucketRows: 0,
    funeralDateWiseFiles: 0,
    funeralDateWiseRows: 0,
    updaterRows: 0,
    closingRows: 0,
    aiAttempts: 0,
    logFiles: 0,
    logLines: 0,
    duplicateRowsSkipped: 0,
    missingOrderIdRowsSkipped: 0,
    datasets: {},
  };

  async function prepareDataset(relativePath, label = relativePath) {
    const dataset = await createSyncDatasetSummary(currentPool, readRows(relativePath), label);
    summary.duplicateRowsSkipped += dataset.duplicateRowsSkipped;
    summary.missingOrderIdRowsSkipped += dataset.missingOrderIdRowsSkipped;
    summary.datasets[label] = {
      sourceRows: dataset.sourceRows,
      syncableRows: dataset.syncableRows,
      duplicateRowsSkipped: dataset.duplicateRowsSkipped,
      missingOrderIdRowsSkipped: dataset.missingOrderIdRowsSkipped,
      existingOrderIdsInSql: dataset.existingOrderIdsInSql,
      newOrderIdsForSql: dataset.newOrderIdsForSql,
    };
    if (dataset.duplicateRowsSkipped > 0) {
      console.warn(`[mysql-import] ${label}: skipped ${dataset.duplicateRowsSkipped} duplicate rows across ${new Set(dataset.duplicateOrderIds).size} order_id values`);
    }
    if (dataset.missingOrderIdRowsSkipped > 0) {
      console.warn(`[mysql-import] ${label}: skipped ${dataset.missingOrderIdRowsSkipped} rows with missing order_id`);
    }
    return dataset.rows;
  }

  const getTaskRows = await prepareDataset(DATASET_CANDIDATES.main.includes("master/master_records.csv") ? "GetTask/data.csv" : "GetTask/data.csv", "GetTask/data.csv");
  const inquiryRows = await prepareDataset("GetOrderInquiry/data.csv", "GetOrderInquiry/data.csv");
  const funeralRows = await prepareDataset("Funeral_Finder/Funeral_data.csv", "Funeral_Finder/Funeral_data.csv");
  const updaterRows = await prepareDataset("Updater/data.csv", "Updater/data.csv");
  const closingRows = await prepareDataset("ClosingTask/data.csv", "ClosingTask/data.csv");

  const inquiryPayload = parseJsonFile("GetOrderInquiry/payload.json", {});
  const funeralPayload = parseJsonFile("Funeral_Finder/payload.json", {});
  const reverifyPayload = parseJsonFile("Funeral_Finder/reverify_payload.json", {});
  const updaterPayload = parseJsonFile("Updater/payload.json", {});
  const closingPayload = parseJsonFile("ClosingTask/payload.json", {});
  const funeralBucketFiles = [
    "Funeral_Finder/Funeral_data_found.csv",
    "Funeral_Finder/Funeral_data_customer.csv",
    "Funeral_Finder/Funeral_data_not_found.csv",
    "Funeral_Finder/Funeral_data_review.csv",
  ];
  const funeralBucketRowTotal = funeralBucketFiles.reduce((total, file) => total + readRows(file).length, 0);
  const dateWiseFiles = listRelativeFiles(
    "Funeral_Finder/date_wise",
    (relativePath, name) => /^Funeral_data.*\.csv$/i.test(name) && relativePath.includes("/date_wise/"),
  );
  const dateWiseRowTotal = dateWiseFiles.reduce((total, file) => total + readRows(file).length, 0);
  const funeralAiAttemptTotal = Object.values(funeralPayload || {}).reduce((total, payload) => {
    const attempts = Array.isArray(payload?.attempts) && payload.attempts.length > 0 ? payload.attempts.length : 1;
    return total + attempts;
  }, 0);
  const reverifyAiAttemptTotal = Object.values(reverifyPayload || {}).reduce((total, payload) => {
    const attempts = Array.isArray(payload?.attempts) && payload.attempts.length > 0 ? payload.attempts.length : 1;
    return total + attempts;
  }, 0);

  async function runPhase(label, callback) {
    console.log(`[mysql-import] ${label} started`);
    try {
      const result = await callback();
      console.log(`[mysql-import] ${label} finished`);
      return result;
    } catch (error) {
      throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`[mysql-import] GetTask rows: ${getTaskRows.length}`);
  await runPhase("GetTask import", () => importGetTaskRows(currentPool, getTaskRows, createProgressReporter("GetTask rows", getTaskRows.length)));
  console.log(`[mysql-import] GetOrderInquiry rows: ${inquiryRows.length}`);
  await runPhase("GetOrderInquiry import", () => importOrderInquiryRows(currentPool, inquiryRows, inquiryPayload, createProgressReporter("GetOrderInquiry rows", inquiryRows.length, { step: 50 })));
  console.log(`[mysql-import] Funeral_Finder current rows: ${funeralRows.length}`);
  await runPhase("Funeral_Finder current import", () => importFuneralRows(currentPool, funeralRows, funeralPayload, "original", {}, createProgressReporter("Funeral current rows", funeralRows.length)));
  console.log("[mysql-import] Funeral_Finder status bucket files: 4");
  summary.funeralStatusBucketRows = await runPhase("Funeral_Finder status bucket import", () => importFuneralStatusBuckets(currentPool, funeralPayload, createProgressReporter("Funeral status bucket rows", funeralBucketRowTotal, { step: 50 })));
  console.log(`[mysql-import] Funeral_Finder status bucket rows: ${summary.funeralStatusBucketRows}`);
  console.log("[mysql-import] Funeral_Finder date-wise history import starting...");
  const dateWiseSummary = await runPhase("Funeral_Finder date-wise import", () => importDateWiseFuneralRows(currentPool, createProgressReporter("Funeral date-wise rows", dateWiseRowTotal, { step: 100 })));
  summary.funeralDateWiseFiles = dateWiseSummary.files;
  summary.funeralDateWiseRows = dateWiseSummary.rows;
  console.log(`[mysql-import] Funeral_Finder date-wise files: ${summary.funeralDateWiseFiles}, rows: ${summary.funeralDateWiseRows}`);
  console.log(`[mysql-import] AI attempts from payload.json: ${Object.keys(funeralPayload || {}).length} order payloads`);
  summary.aiAttempts += await runPhase("AI attempts import from payload.json", () => importAiAttempts(currentPool, funeralPayload, { provider: "openai", strategy: "funeral-finder" }, createProgressReporter("AI attempts payload.json", funeralAiAttemptTotal, { step: 50 })));
  console.log(`[mysql-import] AI attempts from reverify_payload.json: ${Object.keys(reverifyPayload || {}).length} order payloads`);
  summary.aiAttempts += await runPhase("AI attempts import from reverify_payload.json", () => importAiAttempts(currentPool, reverifyPayload, { provider: "mixed", strategy: "reverify" }, createProgressReporter("AI attempts reverify_payload.json", reverifyAiAttemptTotal, { step: 100 })));
  console.log(`[mysql-import] Updater rows: ${updaterRows.length}`);
  await runPhase("Updater CRM import", () => importCrmAttemptRows(currentPool, updaterRows, "updater", updaterPayload, createProgressReporter("Updater rows", updaterRows.length)));
  console.log(`[mysql-import] ClosingTask rows: ${closingRows.length}`);
  await runPhase("ClosingTask CRM import", () => importCrmAttemptRows(currentPool, closingRows, "closing", closingPayload, createProgressReporter("ClosingTask rows", closingRows.length)));
  console.log("[mysql-import] Script log import starting...");
  const logSummary = await runPhase("Script log import", () => importAllScriptLogs(currentPool));
  summary.logFiles = logSummary.files;
  summary.logLines = logSummary.lines;

  const [countRows] = await queryMysql("SELECT COUNT(*) AS total FROM orders WHERE deleted_at IS NULL", [], "count imported orders");
  summary.orders = Number(countRows?.[0]?.total || 0);
  summary.getTaskRows = getTaskRows.length;
  summary.orderInquiryRows = inquiryRows.length;
  summary.funeralRows = funeralRows.length;
  summary.updaterRows = updaterRows.length;
  summary.closingRows = closingRows.length;
  return summary;
}

export async function collectOutputSyncStats({ ensureSchema = true } = {}) {
  if (ensureSchema) {
    await ensureMysqlSchema();
  }
  const currentPool = await getMysqlPool();
  const datasetSpecs = [
    { key: "getTask", path: "GetTask/data.csv" },
    { key: "getOrderInquiry", path: "GetOrderInquiry/data.csv" },
    { key: "funeralFinder", path: "Funeral_Finder/Funeral_data.csv" },
    { key: "updater", path: "Updater/data.csv" },
    { key: "closingTask", path: "ClosingTask/data.csv" },
  ];

  const datasets = {};
  let sourceRows = 0;
  let syncableRows = 0;
  let duplicateRowsSkipped = 0;
  let missingOrderIdRowsSkipped = 0;

  for (const spec of datasetSpecs) {
    const summary = await createSyncDatasetSummary(currentPool, readRows(spec.path), spec.path);
    datasets[spec.key] = {
      path: spec.path,
      sourceRows: summary.sourceRows,
      syncableRows: summary.syncableRows,
      duplicateRowsSkipped: summary.duplicateRowsSkipped,
      missingOrderIdRowsSkipped: summary.missingOrderIdRowsSkipped,
      existingOrderIdsInSql: summary.existingOrderIdsInSql,
      newOrderIdsForSql: summary.newOrderIdsForSql,
    };
    sourceRows += summary.sourceRows;
    syncableRows += summary.syncableRows;
    duplicateRowsSkipped += summary.duplicateRowsSkipped;
    missingOrderIdRowsSkipped += summary.missingOrderIdRowsSkipped;
  }

  const [sqlOrderCounts] = await queryMysql(
    "SELECT COUNT(*) AS total, COUNT(DISTINCT order_id) AS uniqueTotal FROM orders WHERE deleted_at IS NULL",
    [],
    "collect sql order stats",
  );

  return {
    generatedAt: new Date().toISOString(),
    sourceRows,
    syncableRows,
    duplicateRowsSkipped,
    missingOrderIdRowsSkipped,
    sqlOrders: {
      total: Number(sqlOrderCounts?.[0]?.total || 0),
      uniqueTotal: Number(sqlOrderCounts?.[0]?.uniqueTotal || 0),
    },
    datasets,
  };
}

export async function listSqlOrders({
  status = "all",
  search = "",
  sort = "updated_at",
  direction = "desc",
  dateFrom = "",
  dateTo = "",
  limit = 250,
} = {}) {
  const currentPool = await getMysqlPool();
  const processedAtExpression = getProcessedTimestampExpression();
  const safeSort = new Set([
    "order_id", "task_id", "ship_name", "ship_city", "ship_state", "latest_status",
    "last_processed_at", "updated_at", "created_at", "service_datetime",
  ]).has(sort) ? sort : "updated_at";
  const safeDirection = String(direction || "").toLowerCase() === "asc" ? "ASC" : "DESC";
  const params = [];
  const where = ["o.deleted_at IS NULL"];
  if (status && status !== "all") {
    where.push("o.latest_status = ?");
    params.push(toSqlStatus(status));
  }
  if (search) {
    where.push("(o.order_id LIKE ? OR o.task_id LIKE ? OR o.ship_name LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (dateFrom) {
    where.push(`DATE(${processedAtExpression}) >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push(`DATE(${processedAtExpression}) <= ?`);
    params.push(dateTo);
  }
  params.push(Math.max(1, Math.min(Number(limit || 250), 2000)));
  const [rows] = await currentPool.query(
    `
      SELECT
        o.order_id,
        o.task_id,
        o.ship_name,
        o.ship_city,
        o.ship_state,
        o.ship_zip,
        o.ord_instruct,
        o.latest_status AS match_status,
        o.last_processed_at,
        fr.service_datetime,
        fr.funeral_home,
        fr.ai_accuracy_score,
        o.updated_at
      FROM orders o
      LEFT JOIN funeral_results fr
        ON fr.order_id = o.order_id AND fr.is_current = 1
      WHERE ${where.join(" AND ")}
      ORDER BY ${safeSort === "service_datetime" ? "fr.service_datetime" : `o.${safeSort}`} ${safeDirection}
      LIMIT ?
    `,
    params,
  );
  return rows;
}

const SQL_VIEW_FILES = [
  { path: "Funeral_Finder/Funeral_data.csv", label: "Funeral Finder | Complete" },
  { path: "Funeral_Finder/Funeral_data_found.csv", label: "Funeral Finder | Found" },
  { path: "Funeral_Finder/Funeral_data_customer.csv", label: "Funeral Finder | Customer" },
  { path: "Funeral_Finder/Funeral_data_not_found.csv", label: "Funeral Finder | Not Found" },
  { path: "Funeral_Finder/Funeral_data_review.csv", label: "Funeral Finder | Review" },
  { path: "GetOrderInquiry/data.csv", label: "GetOrderInquiry | Latest rows" },
  { path: "GetTask/data.csv", label: "GetTask | Processed orders" },
  { path: "Updater/data.csv", label: "Updater | Latest attempts" },
  { path: "ClosingTask/data.csv", label: "ClosingTask | Latest attempts" },
];

function normalizeSqlViewPath(value = "") {
  return String(value || "").trim().replaceAll("\\", "/");
}

function sqlViewStatusFilterForPath(viewPath = "") {
  const normalized = normalizeSqlViewPath(viewPath).toLowerCase();
  if (normalized.endsWith("funeral_data_found.csv")) return "Found";
  if (normalized.endsWith("funeral_data_customer.csv")) return "Customer";
  if (normalized.endsWith("funeral_data_not_found.csv")) return "NotFound";
  if (normalized.endsWith("funeral_data_review.csv")) return "Review";
  return "";
}

function sqlViewOrderStatusForFuneralStatus(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "notfound") return "not_found";
  return normalized;
}

function normalizeSqlMatchStatusValue(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return "unknown";
  if (/^not\s*found$/i.test(normalized) || /^not_found$/i.test(normalized) || /^notfound$/i.test(normalized)) {
    return "not_found";
  }
  return normalized.toLowerCase();
}

export function listSqlViewFiles() {
  return SQL_VIEW_FILES.slice();
}

export async function readSqlViewContent(relativePath, { limit = 2000 } = {}) {
  const currentPool = await getMysqlPool();
  const normalizedPath = normalizeSqlViewPath(relativePath);
  const maxRows = Math.max(1, Math.min(Number(limit || 2000), 5000));

  if (!SQL_VIEW_FILES.some((entry) => entry.path === normalizedPath)) {
    throw new Error(`Unsupported SQL file view: ${normalizedPath || "(empty path)"}`);
  }

  if (normalizedPath.startsWith("Funeral_Finder/")) {
    const statusFilter = sqlViewStatusFilterForPath(normalizedPath);
    const params = [];
    const where = ["o.deleted_at IS NULL"];
    if (statusFilter) {
      where.push("(fr.match_status = ? OR o.latest_status = ?)");
      params.push(statusFilter, sqlViewOrderStatusForFuneralStatus(statusFilter));
    }
    params.push(maxRows);
    const [rows] = await currentPool.query(
      `
        SELECT
          o.order_id,
          o.task_id,
          o.ship_name,
          o.ship_city,
          o.ship_state,
          o.ship_zip,
          o.ship_care_of,
          o.ship_address,
          o.ord_instruct,
          COALESCE(
            LOWER(CASE WHEN fr.match_status = 'NotFound' THEN 'not_found' ELSE fr.match_status END),
            o.latest_status
          ) AS match_status,
          fr.result_type,
          fr.service_datetime,
          fr.funeral_home,
          fr.address,
          fr.phone,
          fr.ai_accuracy_score,
          fr.source_urls,
          fr.raw_result_json,
          o.source_status,
          o.last_processed_at,
          fr.created_at AS result_created_at,
          fr.updated_at AS result_updated_at,
          o.updated_at
        FROM orders o
        LEFT JOIN funeral_results fr
          ON fr.order_id = o.order_id
          AND fr.is_current = 1
        WHERE ${where.join(" AND ")}
        ORDER BY COALESCE(fr.updated_at, fr.created_at, o.updated_at) DESC, o.order_id DESC
        LIMIT ?
      `,
      params,
    );
    return (rows || []).map((row) => ({
      ...row,
      match_status: normalizeSqlMatchStatusValue(row.match_status),
    }));
  }

  if (normalizedPath === "GetOrderInquiry/data.csv") {
    const [rows] = await currentPool.query(
      `
        SELECT
          o.order_id,
          o.task_id,
          oi.ord_date,
          oi.delivery_date,
          o.ship_name,
          o.ship_city,
          o.ship_state,
          o.ship_zip,
          o.ship_care_of,
          o.ship_address,
          o.ord_instruct,
          o.latest_status AS match_status,
          oi.ship_snapshot_json,
          oi.itemlist_json,
          oi.raw_payload_json,
          oi.source_file,
          oi.fetched_at,
          o.last_processed_at,
          o.updated_at
        FROM order_inquiries oi
        INNER JOIN (
          SELECT MAX(id) AS id
          FROM order_inquiries
          GROUP BY order_id
        ) latest
          ON latest.id = oi.id
        INNER JOIN orders o
          ON o.order_id = oi.order_id
        WHERE o.deleted_at IS NULL
        ORDER BY COALESCE(oi.fetched_at, oi.created_at, o.updated_at) DESC, o.order_id DESC
        LIMIT ?
      `,
      [maxRows],
    );
    return (rows || []).map((row) => ({
      ...row,
      match_status: normalizeSqlMatchStatusValue(row.match_status),
    }));
  }

  if (normalizedPath === "GetTask/data.csv") {
    const [rows] = await currentPool.query(
      `
        SELECT
          o.order_id,
          o.task_id,
          o.source_status,
          o.ship_name,
          o.ship_city,
          o.ship_state,
          o.ship_zip,
          o.ship_care_of,
          o.ship_address,
          o.ord_instruct,
          o.latest_status AS match_status,
          ops.status AS get_task_status,
          ops.attempt_count,
          ops.last_error,
          ops.updated_at AS script_updated_at,
          o.last_processed_at,
          o.updated_at
        FROM orders o
        INNER JOIN order_processing_state ops
          ON ops.order_id = o.order_id
          AND ops.script_name = 'get-task'
        WHERE o.deleted_at IS NULL
        ORDER BY COALESCE(ops.updated_at, o.updated_at) DESC, o.order_id DESC
        LIMIT ?
      `,
      [maxRows],
    );
    return (rows || []).map((row) => ({
      ...row,
      match_status: normalizeSqlMatchStatusValue(row.match_status),
    }));
  }

  if (normalizedPath === "Updater/data.csv" || normalizedPath === "ClosingTask/data.csv") {
    const attemptType = normalizedPath === "Updater/data.csv" ? "updater" : "closing";
    const [rows] = await currentPool.query(
      `
        SELECT
          o.order_id,
          o.task_id,
          o.latest_status AS match_status,
          cua.attempt_type,
          cua.tr_result,
          cua.tr_end_date,
          cua.tr_text,
          cua.request_json,
          cua.response_json,
          cua.response_code,
          cua.upload_status,
          cua.error_message,
          cua.created_at,
          o.last_processed_at,
          o.updated_at
        FROM crm_update_attempts cua
        INNER JOIN (
          SELECT MAX(id) AS id
          FROM crm_update_attempts
          WHERE attempt_type = ?
          GROUP BY order_id
        ) latest
          ON latest.id = cua.id
        INNER JOIN orders o
          ON o.order_id = cua.order_id
        WHERE o.deleted_at IS NULL
        ORDER BY COALESCE(cua.created_at, o.updated_at) DESC, o.order_id DESC
        LIMIT ?
      `,
      [attemptType, maxRows],
    );
    return (rows || []).map((row) => ({
      ...row,
      match_status: normalizeSqlMatchStatusValue(row.match_status),
    }));
  }

  throw new Error(`SQL view is not implemented for: ${normalizedPath}`);
}

export async function getSqlOrderStats({ dateFrom = "", dateTo = "" } = {}) {
  const currentPool = await getMysqlPool();
  const params = [];
  const dateExpression = getProcessedTimestampExpression();
  const normalizedFuneralStatus = "LOWER(REPLACE(REPLACE(COALESCE(fr.match_status, ''), ' ', '_'), '-', '_'))";
  const currentFuneralResultJoin = `
    LEFT JOIN (
      SELECT fr_current.*
      FROM funeral_results fr_current
      INNER JOIN (
        SELECT order_id, MAX(id) AS id
        FROM funeral_results
        WHERE is_current = 1
        GROUP BY order_id
      ) latest_fr
        ON latest_fr.id = fr_current.id
    ) fr
      ON fr.order_id = o.order_id
  `;
  const effectiveStatusExpression = `
    CASE
      WHEN ${normalizedFuneralStatus} IN ('found', 'matched') THEN 'found'
      WHEN ${normalizedFuneralStatus} = 'customer' THEN 'customer'
      WHEN ${normalizedFuneralStatus} IN ('review', 'needs_review') THEN 'review'
      WHEN ${normalizedFuneralStatus} IN ('not_found', 'notfound') THEN 'not_found'
      WHEN o.latest_status IN ('customer', 'found', 'review', 'not_found') THEN o.latest_status
      ELSE 'unknown'
    END
  `;
  const where = ["o.deleted_at IS NULL", "fr.id IS NOT NULL"];
  if (dateFrom) {
    where.push(`DATE(${dateExpression}) >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push(`DATE(${dateExpression}) <= ?`);
    params.push(dateTo);
  }

  const [summaryRows] = await currentPool.query(
    `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN effective_status = 'customer' THEN 1 ELSE 0 END) AS customer,
        SUM(CASE WHEN effective_status = 'found' THEN 1 ELSE 0 END) AS found,
        SUM(CASE WHEN effective_status = 'not_found' THEN 1 ELSE 0 END) AS notfound,
        SUM(CASE WHEN effective_status = 'review' THEN 1 ELSE 0 END) AS review,
        SUM(CASE WHEN effective_status = 'unknown' THEN 1 ELSE 0 END) AS unknown
      FROM (
        SELECT
          o.order_id,
          ${effectiveStatusExpression} AS effective_status
        FROM orders o
        ${currentFuneralResultJoin}
        WHERE ${where.join(" AND ")}
      ) status_rows
    `,
    params,
  );
  const summaryRow = summaryRows?.[0] || {};
  const total = Number(summaryRow.total || 0);
  const customer = Number(summaryRow.customer || 0);
  const found = Number(summaryRow.found || 0);
  const notfound = Number(summaryRow.notfound || 0);
  const review = Number(summaryRow.review || 0);
  const unknown = Number(summaryRow.unknown || 0);

  const [byDateRows] = await currentPool.query(
    `
      SELECT
        report_date AS date,
        COUNT(*) AS total,
        SUM(CASE WHEN effective_status = 'customer' THEN 1 ELSE 0 END) AS customer,
        SUM(CASE WHEN effective_status = 'found' THEN 1 ELSE 0 END) AS found,
        SUM(CASE WHEN effective_status = 'not_found' THEN 1 ELSE 0 END) AS notfound,
        SUM(CASE WHEN effective_status = 'review' THEN 1 ELSE 0 END) AS review
      FROM (
        SELECT
          o.order_id,
          DATE_FORMAT(${dateExpression}, '%Y-%m-%d') AS report_date,
          ${effectiveStatusExpression} AS effective_status
        FROM orders o
        ${currentFuneralResultJoin}
        WHERE ${where.join(" AND ")}
      ) status_rows
      WHERE effective_status <> 'unknown'
      GROUP BY report_date
      ORDER BY date DESC
    `,
    params,
  );

  const withPercent = (value, countTotal) => (
    countTotal > 0 ? Number(((Number(value || 0) / countTotal) * 100).toFixed(1)) : 0
  );

  return {
    source: "sql",
    summary: {
      total,
      customer,
      found,
      notfound,
      review,
      unknown,
      customerPct: withPercent(customer, total),
      foundPct: withPercent(found, total),
      notfoundPct: withPercent(notfound, total),
      reviewPct: withPercent(review, total),
    },
    reconciliation: null,
    byDate: (byDateRows || []).map((row) => {
      const dayTotal = Number(row.total || 0);
      const dayCustomer = Number(row.customer || 0);
      const dayFound = Number(row.found || 0);
      const dayNotFound = Number(row.notfound || 0);
      const dayReview = Number(row.review || 0);
      return {
        date: row.date,
        total: dayTotal,
        customer: dayCustomer,
        found: dayFound,
        notfound: dayNotFound,
        review: dayReview,
        customerPct: withPercent(dayCustomer, dayTotal),
        foundPct: withPercent(dayFound, dayTotal),
        notfoundPct: withPercent(dayNotFound, dayTotal),
        reviewPct: withPercent(dayReview, dayTotal),
      };
    }),
  };
}

export async function getSqlOrderTimeline(orderId) {
  const currentPool = await getMysqlPool();
  const normalized = normalizeOrderId(orderId);
  const [[order]] = await currentPool.query("SELECT * FROM orders WHERE order_id = ? AND deleted_at IS NULL LIMIT 1", [normalized]);
  if (!order) return null;
  const [inquiries] = await currentPool.query("SELECT * FROM order_inquiries WHERE order_id = ? ORDER BY fetched_at DESC, id DESC", [normalized]);
  const [results] = await currentPool.query("SELECT * FROM funeral_results WHERE order_id = ? ORDER BY is_current DESC, id DESC", [normalized]);
  const [attempts] = await currentPool.query("SELECT * FROM crm_update_attempts WHERE order_id = ? ORDER BY id DESC", [normalized]);
  const [processing] = await currentPool.query("SELECT * FROM order_processing_state WHERE order_id = ? ORDER BY script_name ASC", [normalized]);
  const [logs] = await currentPool.query("SELECT * FROM script_run_logs WHERE order_id = ? ORDER BY id DESC LIMIT 500", [normalized]);
  const [audit] = await currentPool.query("SELECT * FROM audit_events WHERE order_id = ? ORDER BY id DESC LIMIT 200", [normalized]);
  return { order, inquiries, results, attempts, processing, logs, audit };
}

export async function getSqlLiveQueueRows({ limit = 500 } = {}) {
  const currentPool = await getMysqlPool();
  const maxRows = Math.max(1, Math.min(Number(limit || 500), 5000));
  const [rows] = await currentPool.query(
    `
      SELECT
        o.order_id,
        o.task_id,
        o.ship_name,
        o.ship_city,
        o.ship_state,
        o.latest_status,
        ops.script_name,
        ops.status,
        ops.attempt_count,
        ops.last_run_uuid,
        ops.last_error,
        ops.updated_at,
        o.last_processed_at
      FROM order_processing_state ops
      INNER JOIN orders o
        ON o.order_id = ops.order_id
      WHERE o.deleted_at IS NULL
        AND ops.status IN ('pending', 'running', 'failed')
      ORDER BY
        CASE ops.status
          WHEN 'running' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'failed' THEN 3
          ELSE 4
        END,
        ops.updated_at DESC,
        o.order_id DESC
      LIMIT ?
    `,
    [maxRows],
  );
  return rows || [];
}

export async function generateSqlReport({ dateFrom = "", dateTo = "", createdBy = null } = {}) {
  const currentPool = await getMysqlPool();
  const timeZone = getConfiguredTimezone();
  const bounds = await getSqlReportDateBounds();
  const processedAtExpression = getProcessedTimestampExpression();
  const boundedFrom = dateFrom && bounds.minDate && dateFrom < bounds.minDate ? bounds.minDate : dateFrom;
  const boundedTo = dateTo && bounds.maxDate && dateTo > bounds.maxDate ? bounds.maxDate : dateTo;
  const params = [];
  const where = ["o.deleted_at IS NULL", "fr.id IS NOT NULL"];
  if (boundedFrom) {
    where.push(`${processedAtExpression} >= ?`);
    params.push(`${boundedFrom} 00:00:00`);
  }
  if (boundedTo) {
    where.push(`${processedAtExpression} < ?`);
    const exclusiveEnd = new Date(`${boundedTo}T00:00:00.000Z`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    params.push(exclusiveEnd.toISOString().slice(0, 19).replace("T", " "));
  }

  const [rows] = await currentPool.query(
    `
      SELECT
        o.order_id,
        o.latest_status,
        o.task_id,
        o.ship_name,
        ${processedAtExpression} AS processed_at,
        fr.service_datetime,
        fr.funeral_home
      FROM orders o
      LEFT JOIN funeral_results fr
        ON fr.order_id = o.order_id AND fr.is_current = 1
      WHERE ${where.join(" AND ")}
      ORDER BY processed_at DESC, o.order_id DESC
    `,
    params,
  );

  const summary = {
    total_orders: 0,
    found_count: 0,
    customer_count: 0,
    review_count: 0,
    not_found_count: 0,
    failed_count: 0,
  };
  const byDateMap = new Map();

  for (const row of rows || []) {
    const normalizedStatus = String(row.latest_status || "").trim();
    const dateKey = formatDateKeyInTimezone(row.processed_at, timeZone) || "Unknown";
    summary.total_orders += 1;
    if (normalizedStatus === "found") summary.found_count += 1;
    else if (normalizedStatus === "customer") summary.customer_count += 1;
    else if (normalizedStatus === "review") summary.review_count += 1;
    else if (normalizedStatus === "not_found") summary.not_found_count += 1;
    else if (normalizedStatus === "failed") summary.failed_count += 1;

    if (!byDateMap.has(dateKey)) {
      byDateMap.set(dateKey, {
        report_date: dateKey,
        total_processed: 0,
        found_count: 0,
        customer_count: 0,
        review_count: 0,
        not_found_count: 0,
        failed_count: 0,
      });
    }
    const bucket = byDateMap.get(dateKey);
    bucket.total_processed += 1;
    if (normalizedStatus === "found") bucket.found_count += 1;
    else if (normalizedStatus === "customer") bucket.customer_count += 1;
    else if (normalizedStatus === "review") bucket.review_count += 1;
    else if (normalizedStatus === "not_found") bucket.not_found_count += 1;
    else if (normalizedStatus === "failed") bucket.failed_count += 1;
  }

  const byDate = Array.from(byDateMap.values()).sort((left, right) => String(right.report_date).localeCompare(String(left.report_date)));
  const generatedAt = new Date();
  const generatedAtLabel = formatDateTimeInTimezone(generatedAt, timeZone);
  const timeZoneLabel = formatTimeZoneLabel(timeZone);

  const generatedHtml = `
    <h1>BlossomTask SQL Report</h1>
    <p><strong>Generated at:</strong> ${generatedAtLabel}</p>
    <p><strong>Timezone:</strong> ${timeZoneLabel}</p>
    <p><strong>Date range:</strong> ${boundedFrom || "All available data"} to ${boundedTo || "Latest available data"}</p>
    <h2>Summary</h2>
    <ul>
      <li>Total processed: ${summary.total_orders}</li>
      <li>Found: ${summary.found_count}</li>
      <li>Customer: ${summary.customer_count}</li>
      <li>Review: ${summary.review_count}</li>
      <li>Not Found: ${summary.not_found_count}</li>
      <li>Failed: ${summary.failed_count}</li>
    </ul>
    <h2>Daily breakdown</h2>
    <table border="1" cellspacing="0" cellpadding="6">
      <thead>
        <tr>
          <th>Date</th>
          <th>Total</th>
          <th>Found</th>
          <th>Customer</th>
          <th>Review</th>
          <th>Not Found</th>
          <th>Failed</th>
        </tr>
      </thead>
      <tbody>
        ${byDate.map((row) => `
          <tr>
            <td>${row.report_date}</td>
            <td>${row.total_processed}</td>
            <td>${row.found_count}</td>
            <td>${row.customer_count}</td>
            <td>${row.review_count}</td>
            <td>${row.not_found_count}</td>
            <td>${row.failed_count}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `.trim();

  const reportUuid = createId("report");
  await currentPool.execute(
    `
      INSERT INTO reports (
        report_uuid, date_from, date_to, total_orders,
        found_count, customer_count, review_count, not_found_count,
        failed_count, generated_html, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      reportUuid,
      boundedFrom || null,
      boundedTo || null,
      summary.total_orders,
      summary.found_count,
      summary.customer_count,
      summary.review_count,
      summary.not_found_count,
      summary.failed_count,
      generatedHtml,
      createdBy,
    ],
  );

  return {
    reportUuid,
    summary,
    byDate,
    generatedHtml,
    bounds,
    dateFrom: boundedFrom || "",
    dateTo: boundedTo || "",
    generatedAt: generatedAt.toISOString(),
    generatedAtLabel,
    timeZone,
    timeZoneLabel,
  };
}

export async function getSqlReportDateBounds() {
  const currentPool = await getMysqlPool();
  const timeZone = getConfiguredTimezone();
  const processedAtExpression = getProcessedTimestampExpression();
  const [[row]] = await currentPool.query(
    `
      SELECT
        MIN(${processedAtExpression}) AS min_date,
        MAX(${processedAtExpression}) AS max_date,
        MAX(${processedAtExpression}) AS last_updated_at
      FROM orders o
      LEFT JOIN funeral_results fr
        ON fr.order_id = o.order_id AND fr.is_current = 1
      WHERE o.deleted_at IS NULL
        AND fr.id IS NOT NULL
    `,
  );
  return {
    minDate: row?.min_date ? formatDateKeyInTimezone(row.min_date, timeZone) : "",
    maxDate: row?.max_date ? formatDateKeyInTimezone(row.max_date, timeZone) : "",
    lastUpdatedAt: row?.last_updated_at ? new Date(row.last_updated_at).toISOString() : null,
    timeZone,
    timeZoneLabel: formatTimeZoneLabel(timeZone),
  };
}

export async function recordAuditEvent({
  orderId = null,
  entityType,
  entityId,
  action,
  beforeJson = null,
  afterJson = null,
  userId = null,
  runUuid = null,
  reason = "",
  ipAddress = null,
}) {
  const currentPool = await getMysqlPool();
  await currentPool.execute(
    `
      INSERT INTO audit_events (
        order_id, entity_type, entity_id, action, before_json, after_json,
        user_id, run_uuid, reason, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      orderId || null,
      entityType,
      entityId,
      action,
      beforeJson ? JSON.stringify(beforeJson) : null,
      afterJson ? JSON.stringify(afterJson) : null,
      userId,
      runUuid,
      reason || null,
      ipAddress,
    ],
  );
}

export async function getOrderProcessingState(orderId, scriptName) {
  const currentPool = await getMysqlPool();
  const normalized = normalizeOrderId(orderId);
  const [[row]] = await currentPool.query(
    "SELECT * FROM order_processing_state WHERE order_id = ? AND script_name = ? LIMIT 1",
    [normalized, scriptName],
  );
  return row || null;
}

export async function setOrderProcessingState({ orderId, scriptName, status, lastRunUuid = null, lastError = null, incrementAttempt = false }) {
  const currentPool = await getMysqlPool();
  const normalized = normalizeOrderId(orderId);
  await currentPool.execute(
    `
      INSERT INTO order_processing_state (order_id, script_name, status, last_run_uuid, attempt_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        last_run_uuid = COALESCE(VALUES(last_run_uuid), last_run_uuid),
        attempt_count = CASE
          WHEN ? THEN attempt_count + 1
          ELSE attempt_count
        END,
        last_error = VALUES(last_error),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      normalized,
      scriptName,
      status,
      lastRunUuid,
      incrementAttempt ? 1 : 0,
      lastError,
      incrementAttempt ? 1 : 0,
    ],
  );
}

export async function createManualOrderUpdate({ orderId, matchStatus, serviceDatetime = null, funeralHome = "", notes = "", userId = null, reason = "manual update" }) {
  const currentPool = await getMysqlPool();
  const normalized = normalizeOrderId(orderId);
  const timeline = await getSqlOrderTimeline(normalized);
  if (!timeline?.order) {
    throw new Error(`Order not found in SQL: ${normalized}`);
  }
  await currentPool.execute("UPDATE funeral_results SET is_current = 0 WHERE order_id = ?", [normalized]);
  await currentPool.execute(
    `
      INSERT INTO funeral_results (
        order_id, result_type, match_status, service_datetime, funeral_home, raw_result_json, is_current
      ) VALUES (?, 'manual', ?, ?, ?, ?, 1)
    `,
    [
      normalized,
      matchStatus,
      parseDateTime(serviceDatetime),
      funeralHome || null,
      toJson({ notes }),
    ],
  );
  await currentPool.execute(
    "UPDATE orders SET latest_status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?",
    [toSqlStatus(matchStatus), normalized],
  );
  await recordAuditEvent({
    orderId: normalized,
    entityType: "order",
    entityId: normalized,
    action: "manual_update",
    beforeJson: timeline.order,
    afterJson: { matchStatus, serviceDatetime, funeralHome, notes },
    userId,
    reason,
  });
  return getSqlOrderTimeline(normalized);
}

export async function scopedDeleteOrderData({ orderId, scopes = [], userId = null, reason = "scoped delete" }) {
  const currentPool = await getMysqlPool();
  const normalized = normalizeOrderId(orderId);
  const selectedScopes = new Set(Array.isArray(scopes) ? scopes : []);
  if (selectedScopes.size === 0) {
    throw new Error("At least one scope must be selected for delete/reset.");
  }
  const timeline = await getSqlOrderTimeline(normalized);
  if (!timeline?.order) {
    throw new Error(`Order not found in SQL: ${normalized}`);
  }

  if (selectedScopes.has("order_inquiries")) {
    await currentPool.execute("DELETE FROM order_inquiries WHERE order_id = ?", [normalized]);
  }
  if (selectedScopes.has("funeral_results")) {
    await currentPool.execute("DELETE FROM funeral_results WHERE order_id = ?", [normalized]);
  }
  if (selectedScopes.has("crm_update_attempts")) {
    await currentPool.execute("DELETE FROM crm_update_attempts WHERE order_id = ?", [normalized]);
  }
  if (selectedScopes.has("ai_attempts")) {
    await currentPool.execute("DELETE FROM ai_attempts WHERE order_id = ?", [normalized]);
  }
  if (selectedScopes.has("script_run_logs")) {
    await currentPool.execute("DELETE FROM script_run_logs WHERE order_id = ?", [normalized]);
  }
  if (selectedScopes.has("order_processing_state")) {
    await currentPool.execute("DELETE FROM order_processing_state WHERE order_id = ?", [normalized]);
  }
  if (selectedScopes.has("order")) {
    await currentPool.execute("UPDATE orders SET deleted_at = CURRENT_TIMESTAMP WHERE order_id = ?", [normalized]);
  }

  await recordAuditEvent({
    orderId: normalized,
    entityType: "order",
    entityId: normalized,
    action: "delete",
    beforeJson: timeline,
    afterJson: { scopes: Array.from(selectedScopes) },
    userId,
    reason,
  });
  return { ok: true, orderId: normalized, scopes: Array.from(selectedScopes) };
}

export const __mysqlPersistenceTest = {
  dedupeRowsByOrderId,
  firstDateTimeCandidate,
  getProcessedTimestampExpression,
  parseDateAndTime,
  parseDateTime,
  prepareRowsForSync,
  toSqlStatus,
};
