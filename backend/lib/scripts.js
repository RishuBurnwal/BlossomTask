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
    hasOptions: true,
    options: ["batch", "interactive"],
  },
  {
    id: "updater",
    name: "Updater",
    description: "Update workflow data and checkpoints",
    file: path.join(scriptsRoot, "Updater.py"),
    hasOptions: false,
    options: [],
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
