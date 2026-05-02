import fs from "node:fs";
import path from "node:path";

import XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getDefaultDatasets, readFileContent } from "../../backend/lib/files.js";

const OUTPUTS_ROOT = path.resolve(process.cwd(), "Scripts", "outputs");
const TEST_OUTPUT_DIR = path.join(OUTPUTS_ROOT, "vitest-normalization");
const TEST_XLSX_PATH = path.join(TEST_OUTPUT_DIR, "legacy_funeral.xlsx");

afterEach(() => {
  fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
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

  it("loads all funeral datasets from the category CSV files", () => {
    const workspaceRoot = path.join(TEST_OUTPUT_DIR, "workspace");
    const outputsRoot = path.join(workspaceRoot, "Scripts", "outputs", "Funeral_Finder");
    vi.spyOn(process, "cwd").mockReturnValue(workspaceRoot);
    fs.mkdirSync(outputsRoot, { recursive: true });

    fs.writeFileSync(
      path.join(outputsRoot, "Funeral_data.csv"),
      "order_id,match_status\n1001,Found\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(outputsRoot, "Funeral_data_not_found.csv"),
      "order_id,match_status\n1002,NotFound\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(outputsRoot, "Funeral_data_review.csv"),
      "order_id,match_status\n1003,Review\n",
      "utf-8",
    );

    const datasets = getDefaultDatasets(20);

    expect(datasets.main.rows).toHaveLength(1);
    expect(datasets.main.summary).toMatchObject({ found: 1, customer: 0, review: 0, notfound: 0 });
    expect(datasets.found.rows).toHaveLength(0);
    expect(datasets.customer.rows).toHaveLength(0);
    expect(datasets.not_found.rows).toHaveLength(1);
    expect(datasets.review.rows).toHaveLength(1);
    expect(datasets.not_found.file).toContain("Funeral_data_not_found.csv");
    expect(datasets.review.file).toContain("Funeral_data_review.csv");
  });

  it("prefers the freshest main dataset file when xlsx was updated after csv", () => {
    const workspaceRoot = path.join(TEST_OUTPUT_DIR, "freshest-workspace");
    const outputsRoot = path.join(workspaceRoot, "Scripts", "outputs", "Funeral_Finder");
    vi.spyOn(process, "cwd").mockReturnValue(workspaceRoot);
    fs.mkdirSync(outputsRoot, { recursive: true });

    const csvPath = path.join(outputsRoot, "Funeral_data.csv");
    const xlsxPath = path.join(outputsRoot, "Funeral_data.xlsx");
    fs.writeFileSync(csvPath, "order_id,match_status\n2001,NotFound\n", "utf-8");

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet([
      { order_id: "2001", match_status: "Customer" },
      { order_id: "2002", match_status: "Found" },
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    XLSX.writeFile(workbook, xlsxPath);
    fs.utimesSync(xlsxPath, new Date("2026-04-30T10:00:00Z"), new Date("2026-04-30T10:00:00Z"));

    const datasets = getDefaultDatasets(20);

    expect(datasets.main.file).toContain("Funeral_data.xlsx");
    expect(datasets.main.summary).toMatchObject({ customer: 1, found: 1, notfound: 0, review: 0 });
  });
});
