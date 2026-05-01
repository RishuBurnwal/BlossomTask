import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./storage.js";

const WORKSPACE_ROOT = path.resolve(process.cwd());
const OUTPUTS_ROOT = path.resolve(WORKSPACE_ROOT, "Scripts", "outputs");
const GOOGLE_SYNC_FILE = "google-sync.json";
const DEFAULT_FOLDER_NAME = "Blossom flower";
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
const CANCEL_FILE_PREFIX = ".cancel_";

function defaultConfig() {
  return {
    enabled: false,
    folderName: DEFAULT_FOLDER_NAME,
    credentials: null,
    credentialsPath: "",
    driveRootFolderId: "",
    lastSyncAt: null,
    lastSyncScope: "",
    lastSyncTarget: "",
    lastSyncedFiles: 0,
    lastError: null,
  };
}

function readConfig() {
  const saved = readJson(GOOGLE_SYNC_FILE, defaultConfig());
  return { ...defaultConfig(), ...(saved || {}) };
}

function persistConfig(config) {
  const payload = {
    ...defaultConfig(),
    ...config,
    credentials: config?.credentials || null,
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

function sanitizePublicState(config) {
  let credentials = null;
  try {
    credentials = resolveCredentialPayload(config);
  } catch {
    credentials = null;
  }

  return {
    configured: Boolean(credentials?.client_email && credentials?.private_key),
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
    outputsRoot: OUTPUTS_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
  };
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
      detail = body ? ` ${body.slice(0, 300)}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`Google Drive request failed (${response.status})${detail}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function buildDriveQuery(query) {
  return `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;
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

  const endpoint = existingFile?.id
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFile.id)}?uploadType=multipart&supportsAllDrives=true`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";
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

async function syncTreeToGoogleDrive(options = {}) {
  const target = normalizeTarget(options.target || "workspace");
  const scope = normalizeScope(target, options.scope || "");
  const config = readConfig();
  const credentials = resolveCredentialPayload(config);

  if (!config.enabled) {
    return {
      skipped: true,
      reason: "Google sync is disabled",
      ...sanitizePublicState(config),
    };
  }

  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error("Google sync is not configured");
  }

  const baseRoot = resolveSyncRoot(target);
  const localRoot = scope ? path.join(baseRoot, scope) : baseRoot;
  if (!fs.existsSync(localRoot) || !fs.statSync(localRoot).isDirectory()) {
    throw new Error(`Sync scope not found: ${scope || "/"}`);
  }

  const accessToken = await getAccessToken(credentials);
  const childCache = new Map();
  const nextConfig = { ...config };
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

  for (const fileEntry of files) {
    const parentRelativePath = fileEntry.relativePath.includes("/")
      ? fileEntry.relativePath.slice(0, fileEntry.relativePath.lastIndexOf("/"))
      : "";
    const parentFolderId = folderIdByRelativePath.get(parentRelativePath) || currentFolderId;
    await uploadFile(accessToken, parentFolderId, fileEntry, childCache);
  }

  nextConfig.lastSyncAt = new Date().toISOString();
  nextConfig.lastSyncScope = scope || "/";
  nextConfig.lastSyncTarget = target;
  nextConfig.lastSyncedFiles = files.length;
  nextConfig.lastError = null;
  persistConfig(nextConfig);

  return {
    synced: true,
    syncTarget: target,
    uploadedFiles: files.length,
    syncedScope: scope || "/",
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
  const credentials = resolveCredentialPayload(config);
  const selectionPaths = Array.isArray(options.paths) ? options.paths : [];

  if (!config.enabled) {
    return {
      skipped: true,
      reason: "Google sync is disabled",
      ...sanitizePublicState(config),
    };
  }

  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error("Google sync is not configured");
  }

  if (selectionPaths.length === 0) {
    throw new Error("No sync paths provided");
  }

  const accessToken = await getAccessToken(credentials);
  const childCache = new Map();
  const nextConfig = { ...config };
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

  for (const fileEntry of files) {
    const parentRelativePath = fileEntry.relativePath.includes("/")
      ? fileEntry.relativePath.slice(0, fileEntry.relativePath.lastIndexOf("/"))
      : "";
    const parentFolderId = folderIdByRelativePath.get(parentRelativePath) || rootFolderId;
    await uploadFile(accessToken, parentFolderId, fileEntry, childCache);
  }

  nextConfig.lastSyncAt = new Date().toISOString();
  nextConfig.lastSyncScope = selectionPaths.join(", ");
  nextConfig.lastSyncTarget = "workspace-selection";
  nextConfig.lastSyncedFiles = files.length;
  nextConfig.lastError = null;
  persistConfig(nextConfig);

  return {
    synced: true,
    syncTarget: "workspace-selection",
    syncedPaths: selectionPaths,
    uploadedFiles: files.length,
    syncedScope: selectionPaths.join(", "),
    ...sanitizePublicState(nextConfig),
  };
}
