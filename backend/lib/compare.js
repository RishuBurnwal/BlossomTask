function categorizeField(field) {
  const key = String(field || "").toLowerCase();
  if (key.startsWith("ship_") || key.includes("address") || key.includes("city") || key.includes("state")) {
    return "shipping";
  }
  if (key.startsWith("pplx_") || key.includes("perplexity")) {
    return "perplexity";
  }
  if (key.startsWith("chatgpt_") || key.includes("gpt")) {
    return "chatgpt";
  }
  if (key.includes("status") || key.includes("error") || key.includes("review")) {
    return "status";
  }
  if (key.includes("order") || key === "ord_id") {
    return "order";
  }
  return "other";
}

function normalizeComparableValue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.0+$/, "");
}

function extractDigits(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function extractOrderId(row) {
  if (!row || typeof row !== "object") return "";
  const directKeys = ["ord_id", "orderId", "ord_ID", "order_id", "ordid", "order_id_value"];
  for (const key of directKeys) {
    if (key in row) {
      const normalized = normalizeComparableValue(row[key]);
      if (normalized) return normalized;
    }
  }

  const fallbackKey = Object.keys(row).find((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === "ordid");
  if (fallbackKey) {
    return normalizeComparableValue(row[fallbackKey]);
  }

  return "";
}

export function compareByOrderId(orderId, sources) {
  const normalizedOrderId = normalizeComparableValue(orderId || "");
  const normalizedOrderDigits = extractDigits(normalizedOrderId);

  if (!normalizedOrderId) {
    return { orderId: "", matches: [], differences: [], summary: [] };
  }

  const sourceRows = (sources || [])
    .map((source) => ({
      source: source.source,
      row:
        (source.rows || []).find((entry) => {
          const candidate = extractOrderId(entry);
          if (candidate === normalizedOrderId) {
            return true;
          }
          if (normalizedOrderDigits) {
            return extractDigits(candidate) === normalizedOrderDigits;
          }
          return false;
        }) ?? null,
    }))
    .filter((entry) => entry.row);

  if (sourceRows.length <= 1) {
    return {
      orderId,
      matches: sourceRows,
      differences: [],
      summary: [],
    };
  }

  const allKeys = new Set();
  sourceRows.forEach(({ row }) => {
    Object.keys(row).forEach((key) => allKeys.add(key));
  });

  const differences = [];
  for (const key of allKeys) {
    const valueMap = sourceRows.map(({ source, row }) => ({ source, value: row[key] ?? "" }));
    const unique = [...new Set(valueMap.map((entry) => normalizeComparableValue(entry.value)))];

    if (unique.length > 1) {
      differences.push({
        field: key,
        values: valueMap,
        category: categorizeField(key),
      });
    }
  }

  const summaryMap = new Map();
  differences.forEach((entry) => {
    summaryMap.set(entry.category, (summaryMap.get(entry.category) || 0) + 1);
  });

  const summary = [...summaryMap.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  return {
    orderId,
    matches: sourceRows,
    differences,
    summary,
  };
}
