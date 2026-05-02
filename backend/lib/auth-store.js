import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Cloudways commonly ships Node 18, so keep auth storage on plain JSON here
// instead of depending on newer built-in SQLite modules.
const dataDir = path.resolve(process.env.BLOSSOM_DATA_DIR || path.resolve(process.cwd(), "backend", "data"));
const storePath = path.join(dataDir, "auth-store.json");
const dbPath = path.join(dataDir, "blossomtask.sqlite");
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

export const reverifyProviderOptions = ["perplexity", "openai"];

let storeCache = null;

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
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

function createEmptyStore() {
  return {
    users: [],
    sessions: [],
    settings: {
      default_model: defaultAdminModel(),
      session_ttl_minutes: String(defaultSessionMinutes),
      display_timezone: defaultTimezone,
      reverify_default_provider: "perplexity",
    },
    model_runs: [],
  };
}

function cloneStore(store) {
  return JSON.parse(JSON.stringify(store));
}

function saveStore(store) {
  ensureDataDir();
  const payload = JSON.stringify(store, null, 2);
  const tempPath = `${storePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, payload, "utf-8");
    fs.renameSync(tempPath, storePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
  storeCache = store;
}

function ensureDefaults(store) {
  store.settings ||= {};
  if (!store.settings.default_model) {
    store.settings.default_model = defaultAdminModel();
  }
  if (!store.settings.session_ttl_minutes) {
    store.settings.session_ttl_minutes = String(defaultSessionMinutes);
  }
  if (!store.settings.display_timezone) {
    store.settings.display_timezone = defaultTimezone;
  }
  if (!store.settings.reverify_default_provider) {
    store.settings.reverify_default_provider = "perplexity";
  }

  store.users ||= [];
  store.sessions ||= [];
  store.model_runs ||= [];

  if (store.users.length === 0) {
    const timestamp = nowIso();
    console.warn(`[auth] Bootstrapping default admin user '${defaultAdminUsername}'`);
    store.users.push({
      id: crypto.randomUUID(),
      username: normalizeUsername(defaultAdminUsername),
      password_hash: hashPassword(defaultAdminPassword),
      role: "admin",
      active: true,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  return store;
}

function getStore() {
  if (storeCache) {
    return storeCache;
  }

  ensureDataDir();
  let store = createEmptyStore();
  if (fs.existsSync(storePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      store = {
        ...store,
        ...parsed,
      };
    } catch {
      store = createEmptyStore();
    }
  }

  store = ensureDefaults(store);
  saveStore(store);
  return store;
}

function updateStore(mutator) {
  const draft = cloneStore(getStore());
  const result = mutator(draft);
  const finalStore = ensureDefaults(draft);
  saveStore(finalStore);
  return result;
}

function serializeUser(record) {
  if (!record) {
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

function serializeSession(session, userOverride = null) {
  if (!session) {
    return null;
  }
  const user = userOverride || getStore().users.find((entry) => entry.id === session.user_id);
  if (!user) {
    return null;
  }
  return {
    id: session.id,
    userId: session.user_id,
    createdAt: session.created_at,
    expiresAt: session.expires_at,
    lastSeenAt: session.last_seen_at,
    revokedAt: session.revoked_at || null,
    userAgent: session.user_agent || "",
    ipAddress: session.ip_address || "",
    username: user.username,
    role: user.role,
    active: Boolean(user.active),
  };
}

function getSettingValue(key, fallback = "") {
  const value = getStore().settings?.[key];
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function setSettingValue(key, value) {
  updateStore((store) => {
    store.settings[key] = String(value);
  });
}

export function listUsers() {
  return getStore().users.map(serializeUser);
}

export function getUserById(userId) {
  return serializeUser(getStore().users.find((entry) => entry.id === userId) || null);
}

export function getUserRecordByUsername(username) {
  const normalized = normalizeUsername(username);
  return getStore().users.find((entry) => entry.username === normalized) || null;
}

export function createUser({ username, password, role = "user" }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("username is required");
  }
  if (!String(password || "").trim()) {
    throw new Error("password is required");
  }
  if (getUserRecordByUsername(normalizedUsername)) {
    throw new Error("username already exists");
  }

  const timestamp = nowIso();
  const user = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    password_hash: hashPassword(password),
    role: normalizeRole(role),
    active: true,
    created_at: timestamp,
    updated_at: timestamp,
  };

  updateStore((store) => {
    store.users.push(user);
  });

  return getUserById(user.id);
}

export function deleteUser(userId) {
  let changed = false;
  updateStore((store) => {
    const before = store.users.length;
    store.users = store.users.filter((entry) => entry.id !== userId);
    store.sessions = store.sessions.filter((entry) => entry.user_id !== userId);
    changed = store.users.length !== before;
  });
  return changed;
}

export function updateUserPassword(userId, password) {
  if (!String(password || "").trim()) {
    throw new Error("password is required");
  }

  let changed = false;
  updateStore((store) => {
    const record = store.users.find((entry) => entry.id === userId);
    if (!record) {
      return;
    }
    record.password_hash = hashPassword(password);
    record.updated_at = nowIso();
    changed = true;
  });
  return changed;
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
  return serializeUser(record);
}

export function createSession(userId, ttlMinutes = defaultSessionMinutes, meta = {}) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + Math.max(5, Number(ttlMinutes || defaultSessionMinutes)) * 60 * 1000);
  const session = {
    id: crypto.randomUUID(),
    user_id: userId,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_seen_at: createdAt.toISOString(),
    revoked_at: null,
    user_agent: String(meta.userAgent || ""),
    ip_address: String(meta.ipAddress || ""),
  };

  updateStore((store) => {
    store.sessions.push(session);
  });

  return getSessionById(session.id);
}

export function getSessionById(sessionId) {
  const store = getStore();
  const session = store.sessions.find((entry) => entry.id === sessionId);
  return serializeSession(session || null);
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

export function touchSession(sessionId, _ttlMinutes = defaultSessionMinutes) {
  let updated = null;
  updateStore((store) => {
    const session = store.sessions.find((entry) => entry.id === sessionId);
    const user = session ? store.users.find((entry) => entry.id === session.user_id) : null;
    if (!session || !user || session.revoked_at || !user.active) {
      return;
    }
    const now = new Date();
    if (new Date(session.expires_at).getTime() <= now.getTime()) {
      session.revoked_at = nowIso();
      return;
    }
    session.last_seen_at = now.toISOString();
    updated = serializeSession(session, user);
  });
  return updated;
}

export function revokeSession(sessionId) {
  updateStore((store) => {
    const session = store.sessions.find((entry) => entry.id === sessionId);
    if (session && !session.revoked_at) {
      session.revoked_at = nowIso();
    }
  });
}

export function revokeSessionsForUser(userId) {
  updateStore((store) => {
    const timestamp = nowIso();
    store.sessions.forEach((entry) => {
      if (entry.user_id === userId && !entry.revoked_at) {
        entry.revoked_at = timestamp;
      }
    });
  });
}

export function listSessions() {
  const store = getStore();
  return store.sessions
    .map((entry) => serializeSession(entry))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function purgeInactiveSessions() {
  let removed = 0;
  updateStore((store) => {
    const nowMs = Date.now();
    store.sessions = store.sessions.filter((entry) => {
      const expiresAtMs = Date.parse(entry.expires_at);
      const isExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
      const isRevoked = Boolean(entry.revoked_at);
      if (isExpired || isRevoked) {
        removed += 1;
        return false;
      }
      return true;
    });
  });
  return removed;
}

export function getActiveModel() {
  return getSettingValue("default_model", defaultAdminModel());
}

export function setActiveModel(modelName) {
  const selected = String(modelName || "").trim();
  if (!selected) {
    throw new Error("model is required");
  }
  setSettingValue("default_model", selected);
  return selected;
}

export function getSessionTtlMinutes() {
  const value = Number(getSettingValue("session_ttl_minutes", String(defaultSessionMinutes)));
  return Number.isFinite(value) && value > 0 ? value : defaultSessionMinutes;
}

export function setSessionTtlMinutes(minutes) {
  const value = Math.max(5, Number(minutes || defaultSessionMinutes));
  setSettingValue("session_ttl_minutes", String(value));
  return value;
}

export function getConfiguredTimezone() {
  return getSettingValue("display_timezone", defaultTimezone) || defaultTimezone;
}

export function setConfiguredTimezone(timeZone) {
  const selected = String(timeZone || "").trim() || defaultTimezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: selected }).format(new Date());
  } catch {
    throw new Error("Invalid timezone");
  }
  setSettingValue("display_timezone", selected);
  return selected;
}

export function getReverifyDefaultProvider() {
  const selected = String(getSettingValue("reverify_default_provider", "perplexity") || "perplexity").trim().toLowerCase();
  return reverifyProviderOptions.includes(selected) ? selected : "perplexity";
}

export function setReverifyDefaultProvider(provider) {
  const selected = String(provider || "").trim().toLowerCase();
  if (!reverifyProviderOptions.includes(selected)) {
    throw new Error("Invalid reverify provider");
  }
  setSettingValue("reverify_default_provider", selected);
  return selected;
}

export function listModelRuns(limit = 500) {
  return getStore().model_runs
    .slice()
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, Math.max(0, Number(limit || 500)))
    .map((entry) => ({
      id: entry.id,
      jobId: entry.job_id,
      scriptId: entry.script_id,
      modelName: entry.model_name,
      status: entry.status,
      source: entry.source,
      createdAt: entry.created_at,
      finishedAt: entry.finished_at || null,
    }));
}

export function recordModelRun({ jobId = null, scriptId = null, modelName, status = "running", source = "script" }) {
  const entry = {
    id: crypto.randomUUID(),
    job_id: jobId,
    script_id: scriptId,
    model_name: modelName,
    status,
    source,
    created_at: nowIso(),
    finished_at: null,
  };
  updateStore((store) => {
    store.model_runs.push(entry);
  });
  return entry.id;
}

export function finishModelRun(runId, status) {
  updateStore((store) => {
    const entry = store.model_runs.find((item) => item.id === runId);
    if (entry) {
      entry.status = status;
      entry.finished_at = nowIso();
    }
  });
}

export function getDatabasePath() {
  return dbPath;
}
