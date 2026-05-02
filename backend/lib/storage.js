import fs from "node:fs";
import path from "node:path";

export const dataDir = path.resolve(process.env.BLOSSOM_DATA_DIR || path.resolve(process.cwd(), "backend", "data"));

export function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function ensureFile(filePath, defaultValue) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
  }
}

export function readJson(fileName, defaultValue) {
  const filePath = path.join(dataDir, fileName);
  ensureFile(filePath, defaultValue);
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

export function writeJson(fileName, value) {
  const filePath = path.join(dataDir, fileName);
  ensureDataDir();
  const payload = JSON.stringify(value, null, 2);
  const tempPath = `${filePath}.tmp`;
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.writeFileSync(tempPath, payload, "utf-8");
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // ignore cleanup errors
      }

      const code = String(error?.code || "").toUpperCase();
      const shouldRetry = ["EPERM", "EBUSY", "UNKNOWN"].includes(code);
      if (!shouldRetry || attempt === maxAttempts) {
        throw error;
      }

      // Small blocking backoff to tolerate transient Windows file locks.
      const waitUntil = Date.now() + attempt * 20;
      while (Date.now() < waitUntil) {
        // intentional no-op busy wait; avoids adding async complexity in sync callsites
      }
    }
  }
}

export function createId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
