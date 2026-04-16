import fs from "node:fs";
import path from "node:path";

import XLSX from "xlsx";
import { afterEach, describe, expect, it } from "vitest";

import { readFileContent } from "../../backend/lib/files.js";

const OUTPUTS_ROOT = path.resolve(process.cwd(), "Scripts", "outputs");
const TEST_OUTPUT_DIR = path.join(OUTPUTS_ROOT, "vitest-normalization");
const TEST_XLSX_PATH = path.join(TEST_OUTPUT_DIR, "legacy_funeral.xlsx");

afterEach(() => {
  fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
});

describe("backend file readers", () => {
  it("normalizes legacy xlsx headers for trend date payloads", () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet([
      {
        ord_id: "5550001",
        trresult: "Found",
        trtext: "Legacy workbook row",
        trenddate: "April 15, 2026 10:00 AM",
      },
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    XLSX.writeFile(workbook, TEST_XLSX_PATH);

    const parsed = readFileContent(path.relative(OUTPUTS_ROOT, TEST_XLSX_PATH), 20);

    expect(parsed.type).toBe("xlsx");
    expect(parsed.parsed).toHaveLength(1);
    expect(parsed.parsed[0]).toMatchObject({
      ord_id: "5550001",
      trResult: "Found",
      trText: "Legacy workbook row",
      trEndDate: "April 15, 2026 10:00 AM",
    });
  });
});