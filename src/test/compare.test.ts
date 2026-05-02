import { describe, expect, it } from "vitest";

import { compareByOrderId } from "../../backend/lib/compare.js";

describe("compareByOrderId", () => {
  it("categorizes funeral fields as funeral instead of other", () => {
    const result = compareByOrderId("1001", [
      {
        source: "left.csv",
        rows: [
          {
            order_id: "1001",
            funeral_home_name: "Alpha Home",
            service_date: "2026-04-20",
            ship_city: "Austin",
          },
        ],
      },
      {
        source: "right.csv",
        rows: [
          {
            order_id: "1001",
            funeral_home_name: "Beta Home",
            service_date: "2026-04-21",
            ship_city: "Dallas",
          },
        ],
      },
    ]);

    const categories = result.differences.map((item) => item.category);

    expect(categories).toContain("funeral");
    expect(categories).not.toContain("other");
  });
});
