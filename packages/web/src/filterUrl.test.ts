import { describe, expect, it } from "vitest";
import { withFilter } from "./filterUrl";

describe("withFilter", () => {
  it("sets q", () => {
    expect(withFilter(new URLSearchParams(), "alert.severity = critical").get("q")).toBe(
      "alert.severity = critical",
    );
  });
  it("removes q when empty and keeps other params", () => {
    const next = withFilter(new URLSearchParams("q=a&x=1"), "");
    expect(next.has("q")).toBe(false);
    expect(next.get("x")).toBe("1");
  });
});
