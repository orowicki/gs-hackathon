import { describe, expect, it } from "vitest";
import type { Filter, FilterNode, FilterParseError } from "../src/types/filter.js";

describe("filter types", () => {
  it("accepts cmp, in, and, or, not trees", () => {
    const tree: FilterNode = {
      type: "and",
      children: [
        { type: "cmp", field: "alert.severity", op: ">=", value: "error" },
        { type: "not", child: { type: "in", field: "alert.source", values: ["a", 1] } },
        { type: "or", children: [{ type: "cmp", field: "payload.n", op: "matches", value: "x*" }] },
      ],
    };
    const f: Filter = tree;
    const err: FilterParseError = { message: "bad", position: 1 };
    expect(f).toBe(tree);
    expect(err.position).toBe(1);
  });
});
