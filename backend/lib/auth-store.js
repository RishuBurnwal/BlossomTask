import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = path.resolve(process.cwd(), "backend", "data", "blossomtask.sqlite");
const defaultSessionMinutes = Number(process.env.SESSION_TTL_MINUTES || 480);
const defaultAdminUsername = String(process.env.BLOSSOMTASK_ADMIN_USERNAME || "admin").trim() || "admin";
const defaultAdminPassword = String(process.env.BLOSSOMTASK_ADMIN_PASSWORD || "admin123").trim() || "admin123";
const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const availableModels = [
  "sonar-pro",
  "sonar",
  "sonar-reasoning",
  "gpt-4o-search-preview",
  "gpt-4.1-mini",
];

let database;

function ensureDataDir() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function getDatabase() {
  if (database) {
    return database;
  }

  ensureDataDir();
  database = new DatabaseSync(dbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent TEXT,
      ip_address TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      script_id TEXT,
      model_name TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
  `);

  seedDefaultAdmin();
  ensureSetting("default_model", defaultAdminModel());
  ensureSetting("session_ttl_minutes", String(defaultSessionMinutes));
  ensureSetting("display_timezone", defaultTimezone);

  return database;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultAdminModel() {
  return availableModels.includes("sonar-pro") ? "sonar-pro" : availableModels[0];
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizeRole(role) {
  return String(role || "user").trim().toLowerCase() === "admin" ? "admin" : "user";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.pbkdf2Sync(String(password), Buffer.from(salt, "hex"), 120000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) {
    return false;
  }
  const candidate = crypto.pbkdf2Sync(String(password), Buffer.from(salt, "hex"), 120000, 32, "sha256").toString("hex");
  const candidateBuffer = Buffer.from(candidate, "hex");
  const hashBuffer = Buffer.from(hash, "hex");
  if (candidateBuffer.length !== hashBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateBuffer, hashBuffer);
}

function ensureSetting(key, value) {
  const db = getDatabase();
  const statement = db.prepare("SELECT value FROM settings WHERE key = ?");
  const row = statement.get(key);
  if (row) {
    return row.value;
  }
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, String(value), nowIso());
  return String(value);
}

function getSetting(key, fallback = "") {
  const row = getDatabase().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? String(row.value) : fallback;
}

function setSetting(key, value) {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, String(value), nowIso());
}

function seedDefaultAdmin() {
  const db = getDatabase();
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count > 0) {
    return;
  }

  const username = defaultAdminUsername;
  const password = process.env.BLOSSOMTASK_ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url");
  console.warn(`[auth] Bootstrapping default admin user '${username}'`);
  createUser({ username, password, role: "admin" });
}

export function listUsers() {
  return getDatabase()
    .prepare(
      "SELECT id, username, role, active, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY created_at ASC",
    )
    .all()
    .map((row) => ({
      ...row,
      active: Boolean(row.active),
    }));
}

export function getUserById(userId) {
  return getDatabase()
    .prepare(
      "SELECT id, username, role, active, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?",
    )
    .get(userId) || null;
}

export function getUserRecordByUsername(username) {
  return getDatabase()
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(normalizeUsername(username)) || null;
}

export function createUser({ username, password, role = "user" }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("username is required");
  }
  if (!String(password || "").trim()) {
    throw new Error("password is required");
  }

  const db = getDatabase();
  const existing = getUserRecordByUsername(normalizedUsername);
  if (existing) {
    throw new Error("username already exists");
  }

  const timestamp = nowIso();
  const user = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    password_hash: hashPassword(password),
    role: normalizeRole(role),
    active: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at)
     VALUES (@id, @username, @password_hash, @role, @active, @created_at, @updated_at)`,
  ).run(user);

  return getUserById(user.id);
}

export function deleteUser(userId) {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  return result.changes > 0;
}

export function updateUserPassword(userId, password) {
  if (!String(password || "").trim()) {
    throw new Error("password is required");
  }
  const passwordHash = hashPassword(password);
  const timestamp = nowIso();
  const result = getDatabase()
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, timestamp, userId);
  return result.changes > 0;
}

export function updateUserPasswordByUsername(username, password) {
  const record = getUserRecordByUsername(username);
  if (!record) {
    return false;
  }
  return updateUserPassword(record.id, password);
}

export function authenticateUser(username, password) {
  const record = getUserRecordByUsername(username);
  if (!record || !record.active) {
    return null;
  }
  if (!verifyPassword(password, record.password_hash)) {
    return null;
  }
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    active: Boolean(record.active),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function createSession(userId, ttlMinutes = defaultSessionMinutes, meta = {}) {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + Math.max(5, Number(ttlMinutes || defaultSessionMinutes)) * 60 * 1000);
  getDatabase()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, revoked_at, user_agent, ip_address)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      userId,
      createdAt.toISOString(),
      expiresAt.toISOString(),
      createdAt.toISOString(),
      String(meta.userAgent || ""),
      String(meta.ipAddress || ""),
    );
  return getSessionById(id);
}

export function getSessionById(sessionId) {
  return getDatabase()
    .prepare(
      `SELECT s.id, s.user_id AS userId, s.created_at AS createdAt, s.expires_at AS expiresAt,
              s.last_seen_at AS lastSeenAt, s.revoked_at AS revokedAt,
              s.user_agent AS userAgent, s.ip_address AS ipAddress,
              u.username, u.role, u.active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(sessionId) || null;
}

export function getValidSession(sessionId) {
  const session = getSessionById(sessionId);
  if (!session || session.revokedAt || !session.active) {
    return null;
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    revokeSession(sessionId);
    return null;
  }
  return session;
}

export function touchSession(sessionId, ttlMinutes = defaultSessionMinutes) {
  const session = getValidSession(sessionId);
  if (!session) {
    return null;
  }
  const updatedAt = new Date();
  const expiresAt = new Date(updatedAt.getTime() + Math.max(5, Number(ttlMinutes || defaultSessionMinutes)) * 60 * 1000);
  getDatabase()
    .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
    .run(updatedAt.toISOString(), expiresAt.toISOString(), sessionId);
  return getSessionById(sessionId);
}

export function revokeSession(sessionId) {
  getDatabase()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
    .run(nowIso(), sessionId);
}

export function revokeSessionsForUser(userId) {
  getDatabase()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(nowIso(), userId);
}

export function listSessions() {
  return getDatabase()
    .prepare(
      `SELECT s.id, s.user_id AS userId, s.created_at AS createdAt, s.expires_at AS expiresAt,
              s.last_seen_at AS lastSeenAt, s.revoked_at AS revokedAt,
              u.username, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC`,
    )
    .all();
}

export function getActiveModel() {
  return getSetting("default_model", defaultAdminModel());
}

export function setActiveModel(modelName) {
  const selected = String(modelName || "").trim();
  if (!selected) {
    throw new Error("model is required");
  }
  setSetting("default_model", selected);
  return selected;
}

export function getSessionTtlMinutes() {
  const value = Number(getSetting("session_ttl_minutes", String(defaultSessionMinutes)));
  return Number.isFinite(value) && value > 0 ? value : defaultSessionMinutes;
}

export function setSessionTtlMinutes(minutes) {
  const value = Math.max(5, Number(minutes || defaultSessionMinutes));
  setSetting("session_ttl_minutes", String(value));
  return value;
}

export function getConfiguredTimezone() {
  return getSetting("display_timezone", defaultTimezone) || defaultTimezone;
}

export function setConfiguredTimezone(timeZone) {
  const selected = String(timeZone || "").trim() || defaultTimezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: selected }).format(new Date());
  } catch {
    throw new Error("Invalid timezone");
  }
  setSetting("display_timezone", selected);
  return selected;
}

export function listModelRuns(limit = 500) {
  return getDatabase()
    .prepare(
      `SELECT id, job_id AS jobId, script_id AS scriptId, model_name AS modelName, status, source,
              created_at AS createdAt, finished_at AS finishedAt
       FROM model_runs
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

export function recordModelRun({ jobId = null, scriptId = null, modelName, status = "running", source = "script" }) {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  getDatabase()
    .prepare(
      `INSERT INTO model_runs (id, job_id, script_id, model_name, status, source, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(id, jobId, scriptId, modelName, status, source, createdAt);
  return id;
}

export function finishModelRun(runId, status) {
  getDatabase()
    .prepare("UPDATE model_runs SET status = ?, finished_at = ? WHERE id = ?")
    .run(status, nowIso(), runId);
}

export function getDatabasePath() {
  return dbPath;
}
