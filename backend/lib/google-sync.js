import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./storage.js";

const WORKSPACE_ROOT = path.resolve(process.cwd());
const OUTPUTS_ROOT = path.resolve(WORKSPACE_ROOT, "Scripts", "outputs");
const GOOGLE_SYNC_FILE = "google-sync.json";
const GOOGLE_SYNC_MANIFEST_FILE = "google-sync-manifest.json";
const DEFAULT_FOLDER_NAME = "Blossom obituary automation";
const DEFAULT_CREDENTIALS_PATH = "blossom-obituary-automation-api.json";
const DEFAULT_OAUTH_CLIENT_SECRET_PATH = "client_secret_427200510-c297l1018e59i06c6socplue1kvdtffd.apps.googleusercontent.com.json";
const DEFAULT_DRIVE_ROOT_FOLDER_ID = "1fmeW0S-rzJ4MraxcZbCyjfaCekC9FCto";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const VALID_TARGETS = new Set(["workspace", "outputs"]);
const WORKSPACE_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".pydeps",
  ".pydeps_wheels",
  "graphify",
  "graphify-out",
]);
const SENSITIVE_WORKSPACE_PATHS = new Set([
  ".env",
  "backend/data/auth-store.json",
  "backend/data/google-sync.json",
]);
const RUNTIME_SYNC_PATHS = [
  "pipeline_checkpoint.json",
  "pipeline_control.json",
  "pipeline_last_summary.json",
  "pipeline_logs.jsonl",
  "pipeline_state.json",
];
const CANCEL_FILE_PREFIX = ".cancel_";

function loadLocalEnvFile() {
  const envPath = path.resolve(WORKSPACE_ROOT, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  fs.readFileSync(envPath, "utf-8").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      return;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadLocalEnvFile();

function defaultOAuthState() {
  return {
    refreshToken: "",
    accessToken: "",
    accessTokenExpiresAt: null,
    tokenType: "Bearer",
    scope: "",
    connectedAt: null,
    lastRefreshAt: null,
    state: "",
  };
}

function defaultConfig() {
  return {
    enabled: fs.existsSync(path.resolve(WORKSPACE_ROOT, DEFAULT_CREDENTIALS_PATH)),
    folderName: DEFAULT_FOLDER_NAME,
    credentials: null,
    credentialsPath: fs.existsSync(path.resolve(WORKSPACE_ROOT, DEFAULT_CREDENTIALS_PATH)) ? DEFAULT_CREDENTIALS_PATH : "",
    driveRootFolderId: DEFAULT_DRIVE_ROOT_FOLDER_ID,
    lastSyncAt: null,
    lastSyncScope: "",
    lastSyncTarget: "",
    lastSyncedFiles: 0,
    lastError: null,
    oauth: defaultOAuthState(),
  };
}

function readConfig() {
  const saved = readJson(GOOGLE_SYNC_FILE, defaultConfig());
  const next = { ...defaultConfig(), ...(saved || {}) };
  next.oauth = { ...defaultOAuthState(), ...(next.oauth || {}) };
  const defaultCredentialsAbsolute = path.resolve(WORKSPACE_ROOT, DEFAULT_CREDENTIALS_PATH);
  if (!next.credentialsPath && fs.existsSync(defaultCredentialsAbsolute)) {
    next.credentialsPath = DEFAULT_CREDENTIALS_PATH;
    next.enabled = true;
  }
  if (!next.driveRootFolderId) {
    next.driveRootFolderId = DEFAULT_DRIVE_ROOT_FOLDER_ID;
  }
  return next;
}

function persistConfig(config) {
  const payload = {
    ...defaultConfig(),
    ...config,
    credentials: config?.credentials || null,
    oauth: { ...defaultOAuthState(), ...(config?.oauth || {}) },
  };
  writeJson(GOOGLE_SYNC_FILE, payload);
  return payload;
}

function base64UrlEncode(value) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf-8");
  return source.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function resolveCredentialPayload(config) {
  if (config.credentials?.client_email && config.credentials?.private_key) {
    return config.credentials;
  }

  const relativeOrAbsolute = String(config.credentialsPath || "").trim();
  if (!relativeOrAbsolute) {
    return null;
  }

  const absolutePath = path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(process.cwd(), relativeOrAbsolute);
  const raw = fs.readFileSync(absolutePath, "utf-8");
  return JSON.parse(raw);
}

function readOAuthClientSecretFile() {
  const explicitPath = String(process.env.GOOGLE_CLIENT_SECRET_JSON || "").trim();
  const candidatePath = explicitPath || DEFAULT_OAUTH_CLIENT_SECRET_PATH;
  const absolutePath = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(WORKSPACE_ROOT, candidatePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
    const client = parsed.web || parsed.installed || parsed;
    return {
      clientId: String(client.client_id || "").trim(),
      clientSecret: String(client.client_secret || "").trim(),
      authUri: String(client.auth_uri || "").trim(),
      tokenUri: String(client.token_uri || "").trim(),
      redirectUris: Array.isArray(client.redirect_uris) ? client.redirect_uris : [],
      sourcePath: path.relative(WORKSPACE_ROOT, absolutePath).replaceAll("\\", "/"),
    };
  } catch {
    return null;
  }
}

function getOAuthConfig() {
  const normalizeEnvSecret = (value) => {
    const trimmed = String(value || "").trim();
    return trimmed === "..." ? "" : trimmed;
  };
  const fileConfig = readOAuthClientSecretFile();
  const clientId = normalizeEnvSecret(process.env.GOOGLE_CLIENT_ID) || fileConfig?.clientId || "";
  const clientSecret = normalizeEnvSecret(process.env.GOOGLE_CLIENT_SECRET) || fileConfig?.clientSecret || "";
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || fileConfig?.redirectUris?.[0] || `http://localhost:${process.env.BACKEND_PORT || 8787}/oauth2callback`).trim();
  const scope = String(process.env.GOOGLE_DRIVE_SCOPE || DRIVE_SCOPE).trim();
  return {
    clientId,
    clientSecret,
    redirectUri,
    scope,
    tokenUri: fileConfig?.tokenUri || "https://oauth2.googleapis.com/token",
    authUri: fileConfig?.authUri || "https://accounts.google.com/o/oauth2/v2/auth",
    sourcePath: fileConfig?.sourcePath || "",
  };
}

function sanitizePublicState(config) {
  let credentials = null;
  try {
    credentials = resolveCredentialPayload(config);
  } catch {
    credentials = null;
  }

  return {
    configured: Boolean(config.oauth?.refreshToken || (credentials?.client_email && credentials?.private_key)),
    enabled: Boolean(config.enabled),
    folderName: String(config.folderName || DEFAULT_FOLDER_NAME),
    credentialsPath: String(config.credentialsPath || ""),
    serviceEmail: credentials?.client_email || "",
    projectId: credentials?.project_id || "",
    driveRootFolderId: String(config.driveRootFolderId || ""),
    lastSyncAt: config.lastSyncAt || null,
    lastSyncScope: config.lastSyncScope || "",
    lastSyncTarget: config.lastSyncTarget || "",
    lastSyncedFiles: Number(config.lastSyncedFiles || 0),
    lastError: config.lastError || null,
    oauthConfigured: Boolean(getOAuthConfig().clientId && getOAuthConfig().clientSecret && getOAuthConfig().redirectUri),
    oauthConnected: Boolean(config.oauth?.refreshToken),
    oauthRedirectUri: getOAuthConfig().redirectUri,
    oauthScope: getOAuthConfig().scope,
    oauthClientSecretPath: getOAuthConfig().sourcePath,
    oauthConnectedAt: config.oauth?.connectedAt || null,
    oauthLastRefreshAt: config.oauth?.lastRefreshAt || null,
    outputsRoot: OUTPUTS_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
  };
}

function driveFileUrl(fileId) {
  return fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : "";
}

function driveFolderUrl(folderId) {
  return folderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` : "";
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return "text/csv";
  if (ext === ".json") return "application/json";
  if (ext === ".jsonl") return "application/x-ndjson";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".xml") return "application/xml";
  return "application/octet-stream";
}

function normalizeTarget(target = "workspace") {
  const normalized = String(target || "workspace").trim().toLowerCase();
  if (!VALID_TARGETS.has(normalized)) {
    throw new Error(`Invalid sync target: ${target}`);
  }
  return normalized;
}

function resolveSyncRoot(target) {
  return normalizeTarget(target) === "outputs" ? OUTPUTS_ROOT : WORKSPACE_ROOT;
}

function normalizeScope(target = "workspace", scope = "") {
  const cleaned = String(scope || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned) {
    return "";
  }
  const root = resolveSyncRoot(target);
  const absolutePath = path.resolve(root, cleaned);
  if (!absolutePath.startsWith(root)) {
    throw new Error("Invalid sync scope");
  }
  return path.relative(root, absolutePath).replaceAll("\\", "/");
}

async function getAccessToken(credentials) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const jwtHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const jwtPayload = base64UrlEncode(JSON.stringify({
    iss: credentials.client_email,
    scope: DRIVE_SCOPE,
    aud: credentials.token_uri || "https://oauth2.googleapis.com/token",
    exp: issuedAt + 3600,
    iat: issuedAt,
  }));
  const unsigned = `${jwtHeader}.${jwtPayload}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).end().sign(credentials.private_key);
  const assertion = `${unsigned}.${base64UrlEncode(signature)}`;

  const response = await fetch(credentials.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google auth failed (${response.status})`);
  }

  const data = await response.json();
  if (!data?.access_token) {
    throw new Error("Google auth failed: missing access token");
  }
  return data.access_token;
}

export function createGoogleOAuthAuthorizationUrl() {
  const oauth = getOAuthConfig();
  if (!oauth.clientId || !oauth.clientSecret || !oauth.redirectUri) {
    throw new Error("Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in .env.");
  }
  const state = crypto.randomBytes(24).toString("hex");
  const config = readConfig();
  persistConfig({
    ...config,
    oauth: {
      ...defaultOAuthState(),
      ...(config.oauth || {}),
      state,
    },
  });
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    response_type: "code",
    scope: oauth.scope,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${oauth.authUri}?${params.toString()}`;
}

export async function exchangeGoogleOAuthCode({ code, state } = {}) {
  const oauth = getOAuthConfig();
  const config = readConfig();
  const receivedCode = String(code || "").trim();
  const receivedState = String(state || "").trim();
  if (!receivedCode) {
    throw new Error("Google OAuth callback missing code");
  }
  if (!oauth.clientId || !oauth.clientSecret || !oauth.redirectUri) {
    throw new Error("Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in .env.");
  }
  if (config.oauth?.state && receivedState !== config.oauth.state) {
    throw new Error("Google OAuth state mismatch. Start the connection again from /auth/google.");
  }

  const response = await fetch(oauth.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: receivedCode,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      redirect_uri: oauth.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed (${response.status}) ${JSON.stringify(body, null, 2)}`);
  }

  const expiresIn = Number(body.expires_in || 3600);
  const nextOAuth = {
    ...defaultOAuthState(),
    ...(config.oauth || {}),
    refreshToken: body.refresh_token || config.oauth?.refreshToken || "",
    accessToken: body.access_token || "",
    accessTokenExpiresAt: body.access_token ? new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString() : null,
    tokenType: body.token_type || "Bearer",
    scope: body.scope || oauth.scope,
    connectedAt: config.oauth?.connectedAt || new Date().toISOString(),
    lastRefreshAt: body.access_token ? new Date().toISOString() : config.oauth?.lastRefreshAt || null,
    state: "",
  };
  if (!nextOAuth.refreshToken) {
    throw new Error("Google OAuth did not return a refresh_token. Open /auth/google again; the URL uses prompt=consent and access_type=offline.");
  }

  const nextConfig = persistConfig({
    ...config,
    enabled: true,
    oauth: nextOAuth,
    lastError: null,
  });
  return sanitizePublicState(nextConfig);
}

async function refreshOAuthAccessToken(config) {
  const oauth = getOAuthConfig();
  const refreshToken = String(config.oauth?.refreshToken || "").trim();
  if (!refreshToken) {
    throw new Error("Google OAuth refresh token is missing. Connect Google Drive from /auth/google first.");
  }
  const expiresAtMs = config.oauth?.accessTokenExpiresAt ? Date.parse(config.oauth.accessTokenExpiresAt) : 0;
  if (config.oauth?.accessToken && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 60_000) {
    return { accessToken: config.oauth.accessToken, config };
  }

  const response = await fetch(oauth.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed (${response.status}) ${JSON.stringify(body, null, 2)}`);
  }

  const expiresIn = Number(body.expires_in || 3600);
  const nextConfig = persistConfig({
    ...config,
    oauth: {
      ...defaultOAuthState(),
      ...(config.oauth || {}),
      accessToken: body.access_token || "",
      accessTokenExpiresAt: body.access_token ? new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString() : null,
      tokenType: body.token_type || config.oauth?.tokenType || "Bearer",
      scope: body.scope || config.oauth?.scope || oauth.scope,
      lastRefreshAt: new Date().toISOString(),
    },
    lastError: null,
  });
  return { accessToken: nextConfig.oauth.accessToken, config: nextConfig };
}

async function resolveDriveAccessToken(config) {
  if (config.oauth?.refreshToken) {
    return refreshOAuthAccessToken(config);
  }
  const credentials = resolveCredentialPayload(config);
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error("Google sync is not configured. Connect OAuth at /auth/google or configure the service account JSON.");
  }
  return { accessToken: await getAccessToken(credentials), config };
}

async function driveRequest(accessToken, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      detail = body ? ` ${body}` : "";
    } catch {
      detail = "";
    }
    const quotaHint = /Service Accounts do not have storage quota/i.test(detail)
      ? " This service-account JSON is valid, but Google will not let a service account create/upload files into a normal My Drive folder because service accounts do not have storage quota. Move the target folder into a Shared Drive and add the service account as Content manager/Contributor, or switch to OAuth user delegation."
      : "";
    throw new Error(`Google Drive request failed (${response.status})${detail}${quotaHint}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function buildDriveQuery(query) {
  return `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,webViewLink,webContentLink,size)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;
}

async function listChildren(accessToken, parentId) {
  const query = `'${parentId}' in parents and trashed = false`;
  const payload = await driveRequest(accessToken, buildDriveQuery(query));
  return Array.isArray(payload?.files) ? payload.files : [];
}

async function ensureFolder(accessToken, name, parentId, childCache) {
  const cacheKey = `folder:${parentId}`;
  let cached = childCache.get(cacheKey);
  if (!cached) {
    cached = await listChildren(accessToken, parentId);
    childCache.set(cacheKey, cached);
  }

  const existingFolder = cached.find((entry) => entry.name === name && entry.mimeType === FOLDER_MIME_TYPE);
  if (existingFolder) {
    return existingFolder.id;
  }

  const created = await driveRequest(accessToken, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentId],
    }),
  });

  cached.push(created);
  return created.id;
}

async function ensureRootFolder(accessToken, config, childCache) {
  if (config.driveRootFolderId) {
    try {
      const existing = await driveRequest(
        accessToken,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(config.driveRootFolderId)}?fields=id,name,mimeType&supportsAllDrives=true`,
      );
      if (existing?.id && existing?.mimeType === FOLDER_MIME_TYPE) {
        return existing.id;
      }
    } catch {
      // Fall through and recreate the folder if the saved id is stale.
    }
  }

  const query = `'root' in parents and trashed = false and mimeType = '${FOLDER_MIME_TYPE}' and name = '${String(config.folderName || DEFAULT_FOLDER_NAME).replace(/'/g, "\\'")}'`;
  const payload = await driveRequest(accessToken, buildDriveQuery(query));
  const existingFolder = Array.isArray(payload?.files) ? payload.files[0] : null;
  if (existingFolder?.id) {
    return existingFolder.id;
  }

  const created = await driveRequest(accessToken, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: String(config.folderName || DEFAULT_FOLDER_NAME),
      mimeType: FOLDER_MIME_TYPE,
      parents: ["root"],
    }),
  });

  childCache.delete("folder:root");
  return created.id;
}

function shouldIgnoreRelativePath(relativePath, config, target) {
  const normalizedPath = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalizedPath) {
    return false;
  }

  const segments = normalizedPath.split("/").filter(Boolean);
  const leafName = segments[segments.length - 1] || "";
  if (leafName.startsWith(CANCEL_FILE_PREFIX)) {
    return true;
  }

  if (normalizeTarget(target) !== "workspace") {
    return false;
  }

  if (segments.some((segment) => WORKSPACE_IGNORED_DIRS.has(segment))) {
    return true;
  }

  let credentialsRelativePath = "";
  try {
    if (config.credentialsPath) {
      credentialsRelativePath = path.relative(
        WORKSPACE_ROOT,
        path.isAbsolute(config.credentialsPath)
          ? config.credentialsPath
          : path.resolve(WORKSPACE_ROOT, config.credentialsPath),
      ).replaceAll("\\", "/");
    }
  } catch {
    credentialsRelativePath = "";
  }

  if (SENSITIVE_WORKSPACE_PATHS.has(normalizedPath)) {
    return true;
  }

  if (credentialsRelativePath && normalizedPath === credentialsRelativePath) {
    return true;
  }

  return false;
}

function walkScope(localRoot, config, target) {
  const folders = [];
  const files = [];

  function visit(currentPath, relativePath = "") {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    entries.forEach((entry) => {
      const entryAbsolute = path.join(currentPath, entry.name);
      const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (shouldIgnoreRelativePath(entryRelative, config, target)) {
        return;
      }
      if (entry.isDirectory()) {
        folders.push(entryRelative);
        visit(entryAbsolute, entryRelative);
      } else if (entry.isFile()) {
        files.push({
          absolutePath: entryAbsolute,
          relativePath: entryRelative.replaceAll("\\", "/"),
          name: entry.name,
        });
      }
    });
  }

  visit(localRoot);
  return { folders, files };
}

async function uploadFile(accessToken, parentId, fileEntry, childCache) {
  const cacheKey = `folder:${parentId}`;
  let cached = childCache.get(cacheKey);
  if (!cached) {
    cached = await listChildren(accessToken, parentId);
    childCache.set(cacheKey, cached);
  }

  const existingFile = cached.find((entry) => entry.name === fileEntry.name && entry.mimeType !== FOLDER_MIME_TYPE);
  const boundary = `blossom-${crypto.randomUUID()}`;
  const metadata = Buffer.from(
    JSON.stringify(existingFile?.id ? { name: fileEntry.name } : { name: fileEntry.name, parents: [parentId] }),
    "utf-8",
  );
  const media = fs.readFileSync(fileEntry.absolutePath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, "utf-8"),
    metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${getMimeType(fileEntry.absolutePath)}\r\n\r\n`, "utf-8"),
    media,
    Buffer.from(`\r\n--${boundary}--`, "utf-8"),
  ]);

  const fields = "id,name,mimeType,modifiedTime,webViewLink,webContentLink,size";
  const endpoint = existingFile?.id
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFile.id)}?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(fields)}`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
  const method = existingFile?.id ? "PATCH" : "POST";
  const uploaded = await driveRequest(accessToken, endpoint, {
    method,
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });

  if (!existingFile) {
    cached.push(uploaded);
  }

  return uploaded;
}

export function getGoogleSyncState() {
  return sanitizePublicState(readConfig());
}

export function recordGoogleSyncFailure(error, context = "Google sync failed") {
  const config = readConfig();
  const manifest = readManifest();
  const message = error instanceof Error ? error.message : String(error || "Unknown Google sync error");
  const nextConfig = {
    ...config,
    lastError: message,
  };
  addManifestLog(manifest, `${context}: ${message}`, "error");
  persistConfig(nextConfig);
  persistManifest(manifest);
  return sanitizePublicState(nextConfig);
}

export function saveGoogleSyncConfig(payload = {}) {
  const current = readConfig();
  const next = { ...current };

  if (Object.prototype.hasOwnProperty.call(payload, "enabled")) {
    next.enabled = Boolean(payload.enabled);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "folderName")) {
    next.folderName = String(payload.folderName || "").trim() || DEFAULT_FOLDER_NAME;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "credentialsPath")) {
    next.credentialsPath = String(payload.credentialsPath || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, "driveRootFolderId")) {
    next.driveRootFolderId = String(payload.driveRootFolderId || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, "credentialsJson")) {
    const rawCredentials = String(payload.credentialsJson || "").trim();
    next.credentials = rawCredentials ? JSON.parse(rawCredentials) : null;
  }

  try {
    const resolved = resolveCredentialPayload(next);
    if (resolved && (!resolved.client_email || !resolved.private_key)) {
      throw new Error("Invalid Google service account JSON");
    }
    next.lastError = null;
  } catch (error) {
    next.lastError = error instanceof Error ? error.message : "Invalid Google credentials";
    persistConfig(next);
    throw error;
  }

  return sanitizePublicState(persistConfig(next));
}

function scriptLabelForRelativePath(relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  const outputMatch = normalized.match(/^Scripts\/outputs\/([^/]+)/i);
  if (outputMatch?.[1]) {
    return outputMatch[1];
  }
  return "Runtime";
}

function readManifest() {
  const saved = readJson(GOOGLE_SYNC_MANIFEST_FILE, { files: {}, logs: [] });
  return {
    files: saved?.files && typeof saved.files === "object" ? saved.files : {},
    logs: Array.isArray(saved?.logs) ? saved.logs : [],
  };
}

function persistManifest(manifest) {
  const next = {
    files: manifest.files || {},
    logs: Array.isArray(manifest.logs) ? manifest.logs.slice(0, 80) : [],
    updatedAt: new Date().toISOString(),
  };
  writeJson(GOOGLE_SYNC_MANIFEST_FILE, next);
  return next;
}

function addManifestLog(manifest, message, level = "info") {
  manifest.logs = [
    { id: crypto.randomUUID(), at: new Date().toISOString(), level, message },
    ...(Array.isArray(manifest.logs) ? manifest.logs : []),
  ].slice(0, 80);
}

function listLocalSyncFiles() {
  const config = readConfig();
  const selectionPaths = ["Scripts/outputs", ...RUNTIME_SYNC_PATHS];
  const { files } = collectWorkspaceSelectionEntries(selectionPaths, config);
  return files.map((file) => {
    const stat = fs.statSync(file.absolutePath);
    return {
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      name: file.name,
      group: scriptLabelForRelativePath(file.relativePath),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      exists: true,
      status: "available",
    };
  });
}

function updateManifestWithLocalFiles(manifest, localFiles) {
  const seen = new Set();
  localFiles.forEach((file) => {
    seen.add(file.relativePath);
    const previous = manifest.files[file.relativePath] || {};
    manifest.files[file.relativePath] = {
      ...previous,
      ...file,
      deleted: false,
      status: previous.driveFileId ? "synced" : "available",
      lastSeenAt: new Date().toISOString(),
    };
  });

  Object.entries(manifest.files).forEach(([relativePath, entry]) => {
    if (seen.has(relativePath)) {
      return;
    }
    manifest.files[relativePath] = {
      ...entry,
      exists: false,
      deleted: true,
      status: "deleted",
      deletedAt: entry.deletedAt || new Date().toISOString(),
    };
  });
}

function publicManifest(config = readConfig()) {
  const manifest = readManifest();
  const localFiles = listLocalSyncFiles();
  updateManifestWithLocalFiles(manifest, localFiles);
  persistManifest(manifest);

  const files = Object.values(manifest.files)
    .sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath)))
    .map((entry) => ({
      relativePath: entry.relativePath,
      name: entry.name || path.basename(entry.relativePath || ""),
      group: entry.group || scriptLabelForRelativePath(entry.relativePath),
      size: Number(entry.size || 0),
      modifiedAt: entry.modifiedAt || null,
      exists: entry.exists !== false,
      deleted: Boolean(entry.deleted),
      status: entry.status || (entry.deleted ? "deleted" : entry.driveFileId ? "synced" : "available"),
      driveFileId: entry.driveFileId || "",
      driveUrl: entry.driveUrl || driveFileUrl(entry.driveFileId),
      syncedAt: entry.syncedAt || null,
      deletedAt: entry.deletedAt || null,
      lastError: entry.lastError || null,
    }));

  const groups = Object.values(files.reduce((accumulator, file) => {
    const group = file.group || "Runtime";
    accumulator[group] ||= {
      name: group,
      folderUrl: group === "Runtime" ? driveFolderUrl(config.driveRootFolderId) : "",
      totalFiles: 0,
      syncedFiles: 0,
      deletedFiles: 0,
      files: [],
    };
    accumulator[group].totalFiles += 1;
    if (file.status === "synced") accumulator[group].syncedFiles += 1;
    if (file.deleted) accumulator[group].deletedFiles += 1;
    accumulator[group].files.push(file);
    return accumulator;
  }, {})).sort((left, right) => String(left.name).localeCompare(String(right.name)));

  return {
    ...sanitizePublicState(config),
    rootFolderUrl: driveFolderUrl(config.driveRootFolderId),
    groups,
    files,
    logs: manifest.logs || [],
  };
}

export function getGoogleSyncManifest() {
  return publicManifest();
}

function updateManifestAfterUploads(uploadedEntries, config, summaryMessage) {
  const manifest = readManifest();
  const localFiles = listLocalSyncFiles();
  updateManifestWithLocalFiles(manifest, localFiles);
  uploadedEntries.forEach((entry) => {
    if (!entry?.relativePath) {
      return;
    }
    const previous = manifest.files[entry.relativePath] || {};
    manifest.files[entry.relativePath] = {
      ...previous,
      relativePath: entry.relativePath,
      name: entry.name || previous.name || path.basename(entry.relativePath),
      group: previous.group || scriptLabelForRelativePath(entry.relativePath),
      driveFileId: entry.driveFileId || previous.driveFileId || "",
      driveUrl: entry.driveUrl || previous.driveUrl || driveFileUrl(entry.driveFileId),
      syncedAt: new Date().toISOString(),
      exists: true,
      deleted: false,
      status: "synced",
      lastError: null,
    };
  });
  addManifestLog(manifest, summaryMessage || `Synced ${uploadedEntries.length} files to Google Drive`);
  persistManifest(manifest);
  return publicManifest(config);
}

async function syncTreeToGoogleDrive(options = {}) {
  const target = normalizeTarget(options.target || "workspace");
  const scope = normalizeScope(target, options.scope || "");
  const config = readConfig();

  if (!config.enabled) {
    return {
      skipped: true,
      reason: "Google sync is disabled",
      ...sanitizePublicState(config),
    };
  }

  const baseRoot = resolveSyncRoot(target);
  const localRoot = scope ? path.join(baseRoot, scope) : baseRoot;
  if (!fs.existsSync(localRoot) || !fs.statSync(localRoot).isDirectory()) {
    throw new Error(`Sync scope not found: ${scope || "/"}`);
  }

  const tokenResult = await resolveDriveAccessToken(config);
  const accessToken = tokenResult.accessToken;
  const childCache = new Map();
  const nextConfig = { ...tokenResult.config };
  const rootFolderId = await ensureRootFolder(accessToken, nextConfig, childCache);
  nextConfig.driveRootFolderId = rootFolderId;

  let currentFolderId = rootFolderId;
  const scopeSegments = scope.split("/").filter(Boolean);
  for (const segment of scopeSegments) {
    currentFolderId = await ensureFolder(accessToken, segment, currentFolderId, childCache);
  }

  const folderIdByRelativePath = new Map([["", currentFolderId]]);
  const { folders, files } = walkScope(localRoot, config, target);

  for (const folderRelativePath of folders) {
    const parentRelativePath = folderRelativePath.includes("/")
      ? folderRelativePath.slice(0, folderRelativePath.lastIndexOf("/"))
      : "";
    const parentFolderId = folderIdByRelativePath.get(parentRelativePath);
    if (!parentFolderId) {
      throw new Error(`Missing parent folder mapping for ${folderRelativePath}`);
    }
    const folderName = folderRelativePath.split("/").pop();
    const folderId = await ensureFolder(accessToken, folderName, parentFolderId, childCache);
    folderIdByRelativePath.set(folderRelativePath, folderId);
  }

  const uploadedEntries = [];
  for (const fileEntry of files) {
    const parentRelativePath = fileEntry.relativePath.includes("/")
      ? fileEntry.relativePath.slice(0, fileEntry.relativePath.lastIndexOf("/"))
      : "";
    const parentFolderId = folderIdByRelativePath.get(parentRelativePath) || currentFolderId;
    const uploaded = await uploadFile(accessToken, parentFolderId, fileEntry, childCache);
    const workspaceRelativePath = target === "outputs"
      ? `Scripts/outputs/${scope ? `${scope}/` : ""}${fileEntry.relativePath}`.replaceAll("\\", "/")
      : `${scope ? `${scope}/` : ""}${fileEntry.relativePath}`.replaceAll("\\", "/");
    uploadedEntries.push({
      relativePath: workspaceRelativePath,
      name: fileEntry.name,
      driveFileId: uploaded?.id || "",
      driveUrl: uploaded?.webViewLink || driveFileUrl(uploaded?.id),
    });
  }

  nextConfig.lastSyncAt = new Date().toISOString();
  nextConfig.lastSyncScope = scope || "/";
  nextConfig.lastSyncTarget = target;
  nextConfig.lastSyncedFiles = files.length;
  nextConfig.lastError = null;
  persistConfig(nextConfig);

  const manifest = updateManifestAfterUploads(
    uploadedEntries,
    nextConfig,
    `Synced ${files.length} file${files.length === 1 ? "" : "s"} from ${target}:${scope || "/"}`,
  );

  return {
    synced: true,
    syncTarget: target,
    uploadedFiles: files.length,
    syncedScope: scope || "/",
    manifest,
    ...sanitizePublicState(nextConfig),
  };
}

function normalizeWorkspaceSelectionPath(relativePath) {
  const cleaned = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned) {
    throw new Error("Sync selection path is required");
  }
  const absolutePath = path.resolve(WORKSPACE_ROOT, cleaned);
  if (!absolutePath.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Invalid selection path: ${relativePath}`);
  }
  return path.relative(WORKSPACE_ROOT, absolutePath).replaceAll("\\", "/");
}

function ensureFolderChain(folderRelativePath, folderSet) {
  if (!folderRelativePath) {
    return;
  }
  const segments = folderRelativePath.split("/").filter(Boolean);
  let current = "";
  segments.forEach((segment) => {
    current = current ? `${current}/${segment}` : segment;
    folderSet.add(current);
  });
}

function collectWorkspaceSelectionEntries(selectionPaths, config) {
  const folderSet = new Set();
  const files = [];

  selectionPaths.forEach((selectionPath) => {
    const normalizedPath = normalizeWorkspaceSelectionPath(selectionPath);
    if (shouldIgnoreRelativePath(normalizedPath, config, "workspace")) {
      return;
    }

    const absolutePath = path.join(WORKSPACE_ROOT, normalizedPath);
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      ensureFolderChain(normalizedPath, folderSet);
      const walked = walkScope(absolutePath, config, "workspace");
      walked.folders.forEach((folderRelativePath) => {
        ensureFolderChain(`${normalizedPath}/${folderRelativePath}`, folderSet);
      });
      walked.files.forEach((fileEntry) => {
        files.push({
          absolutePath: fileEntry.absolutePath,
          relativePath: `${normalizedPath}/${fileEntry.relativePath}`.replaceAll("\\", "/"),
          name: fileEntry.name,
        });
      });
      return;
    }

    ensureFolderChain(path.dirname(normalizedPath).replaceAll("\\", "/"), folderSet);
    files.push({
      absolutePath,
      relativePath: normalizedPath,
      name: path.basename(normalizedPath),
    });
  });

  return {
    folders: Array.from(folderSet).sort((left, right) => left.localeCompare(right)),
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
}

export async function syncOutputsToGoogleDrive(options = {}) {
  return syncTreeToGoogleDrive({ ...options, target: "outputs" });
}

export async function syncProjectToGoogleDrive(options = {}) {
  return syncTreeToGoogleDrive({ ...options, target: options.target || "workspace" });
}

export async function syncWorkspaceSelectionToGoogleDrive(options = {}) {
  const config = readConfig();
  const selectionPaths = Array.isArray(options.paths) ? options.paths : [];

  if (!config.enabled) {
    return {
      skipped: true,
      reason: "Google sync is disabled",
      ...sanitizePublicState(config),
    };
  }

  if (selectionPaths.length === 0) {
    throw new Error("No sync paths provided");
  }

  const tokenResult = await resolveDriveAccessToken(config);
  const accessToken = tokenResult.accessToken;
  const childCache = new Map();
  const nextConfig = { ...tokenResult.config };
  const rootFolderId = await ensureRootFolder(accessToken, nextConfig, childCache);
  nextConfig.driveRootFolderId = rootFolderId;

  const folderIdByRelativePath = new Map([["", rootFolderId]]);
  const { folders, files } = collectWorkspaceSelectionEntries(selectionPaths, config);

  for (const folderRelativePath of folders) {
    const parentRelativePath = folderRelativePath.includes("/")
      ? folderRelativePath.slice(0, folderRelativePath.lastIndexOf("/"))
      : "";
    const parentFolderId = folderIdByRelativePath.get(parentRelativePath) || rootFolderId;
    const folderName = folderRelativePath.split("/").pop();
    const folderId = await ensureFolder(accessToken, folderName, parentFolderId, childCache);
    folderIdByRelativePath.set(folderRelativePath, folderId);
  }

  const uploadedEntries = [];
  for (const fileEntry of files) {
    const parentRelativePath = fileEntry.relativePath.includes("/")
      ? fileEntry.relativePath.slice(0, fileEntry.relativePath.lastIndexOf("/"))
      : "";
    const parentFolderId = folderIdByRelativePath.get(parentRelativePath) || rootFolderId;
    const uploaded = await uploadFile(accessToken, parentFolderId, fileEntry, childCache);
    uploadedEntries.push({
      relativePath: fileEntry.relativePath,
      name: fileEntry.name,
      driveFileId: uploaded?.id || "",
      driveUrl: uploaded?.webViewLink || driveFileUrl(uploaded?.id),
    });
  }

  nextConfig.lastSyncAt = new Date().toISOString();
  nextConfig.lastSyncScope = selectionPaths.join(", ");
  nextConfig.lastSyncTarget = "workspace-selection";
  nextConfig.lastSyncedFiles = files.length;
  nextConfig.lastError = null;
  persistConfig(nextConfig);

  const manifest = updateManifestAfterUploads(
    uploadedEntries,
    nextConfig,
    `Synced ${files.length} approved runtime file${files.length === 1 ? "" : "s"}`,
  );

  return {
    synced: true,
    syncTarget: "workspace-selection",
    syncedPaths: selectionPaths,
    uploadedFiles: files.length,
    syncedScope: selectionPaths.join(", "),
    manifest,
    ...sanitizePublicState(nextConfig),
  };
}
