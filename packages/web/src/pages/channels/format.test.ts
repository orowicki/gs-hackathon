import { describe, expect, it } from "vitest";
import { errorMessage } from "./api";
import { relativeTime, statusColor } from "./format";

const now = Date.parse("2026-01-01T12:00:00Z");

describe("relativeTime", () => {
  it("formats units", () => {
    expect(relativeTime("2026-01-01T11:59:30Z", now)).toBe("30s ago");
    expect(relativeTime("2026-01-01T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-01-01T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2025-12-30T12:00:00Z", now)).toBe("2d ago");
  });
  it("returns input when invalid", () => {
    expect(relativeTime("nope", now)).toBe("nope");
  });
});

describe("statusColor", () => {
  it("uses token variables", () => {
    expect(statusColor(true)).toBe("var(--valid)");
    expect(statusColor(false)).toBe("var(--critical)");
  });
});

describe("errorMessage", () => {
  it("maps 503 and 404", () => {
    expect(errorMessage(503, "delivery not configured")).toMatch(
      /not configured/,
    );
    expect(errorMessage(404, "")).toMatch(/not found/);
    expect(errorMessage(500, "boom")).toBe("Request failed (500): boom");
  });
});
