import fs from "node:fs";
import path from "node:path";

export const dataDir = path.resolve(process.cwd(), "backend", "data");

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
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

export function createId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
