import path from "node:path";

const scriptsRoot = path.resolve(process.cwd(), "Scripts");

export const scriptCatalog = [
  {
    id: "get-task",
    name: "GetTask",
    description: "Fetch and process open tasks",
    file: path.join(scriptsRoot, "GetTask.py"),
    hasOptions: false,
    options: [],
  },
  {
    id: "get-order-inquiry",
    name: "GetOrderInquiry",
    description: "Fetch order inquiry records",
    file: path.join(scriptsRoot, "GetOrderInquiry.py"),
    hasOptions: false,
    options: [],
  },
  {
    id: "funeral-finder",
    name: "Funeral_Finder",
    description: "Search, verify, and classify funeral data",
    file: path.join(scriptsRoot, "Funeral_Finder.py"),
    hasOptions: false,
    options: [],
    supportsForceLatest: true,
    forceLatestOptions: [10, 25, 50, 100],
  },
  {
    id: "reverify",
    name: "Reverify",
    description: "Re-verify NotFound and Review records using multi-strategy Perplexity queries",
    file: path.join(scriptsRoot, "reverify.py"),
    hasOptions: true,
    options: ["both", "not_found", "review"],
    supportsForceLatest: true,
    forceLatestOptions: [10, 25, 50, 100],
  },
  {
    id: "updater",
    name: "Updater",
    description: "Update workflow data and checkpoints",
    file: path.join(scriptsRoot, "Updater.py"),
    hasOptions: true,
    options: ["complete", "found_only", "not_found", "review"],
  },
  {
    id: "closing-task",
    name: "ClosingTask",
    description: "Close tasks for processed orders",
    file: path.join(scriptsRoot, "ClosingTask.py"),
    hasOptions: false,
    options: [],
  },
];

export function getScriptById(scriptId) {
  return scriptCatalog.find((item) => item.id === scriptId) ?? null;
}
