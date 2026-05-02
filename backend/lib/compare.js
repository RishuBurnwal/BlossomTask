function categorizeField(field) {
  const key = String(field || "").toLowerCase();
  if (key === "order_id" || key === "task_id" || key === "ord_id" || key.includes("order")) {
    return "order";
  }
  if (key.startsWith("ship_")) {
    return "shipping";
  }
  if (
    key === "funeral_home_name"
    || key === "funeral_address"
    || key === "funeral_phone"
    || key === "service_type"
    || key.startsWith("service_")
    || key.startsWith("visitation_")
    || key.startsWith("ceremony_")
  ) {
    return "funeral";
  }
  if (key.startsWith("delivery_")) {
    return "delivery";
  }
  if (key.includes("status") || key.includes("error") || key.includes("review") || key.includes("score")) {
    return "status";
  }
  if (key.startsWith("pplx_") || key.includes("perplexity")) {
    return "perplexity";
  }
  if (key.startsWith("chatgpt_") || key.includes("gpt")) {
    return "chatgpt";
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

function isOrderIdLikeKey(normalizedKey) {
  return (
    normalizedKey.includes("ordid")
    || normalizedKey.includes("orderid")
    || normalizedKey.includes("orderno")
    || normalizedKey.includes("ordernumber")
    || normalizedKey.includes("ordernum")
  );
}

function extractOrderId(row) {
  if (!row || typeof row !== "object") return "";
  const directKeys = [
    "ord_id",
    "orderId",
    "ord_ID",
    "order_id",
    "ordid",
    "order_id_value",
    "Order ID",
    "order id",
    "OrderId",
    "orderid",
    "Order_ID",
  ];
  for (const key of directKeys) {
    if (key in row) {
      const normalized = normalizeComparableValue(row[key]);
      if (normalized) return normalized;
    }
  }

  const fallbackKey = Object.keys(row).find((key) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return isOrderIdLikeKey(normalized);
  });
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
