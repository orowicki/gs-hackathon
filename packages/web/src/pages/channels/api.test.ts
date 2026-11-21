import { describe, expect, it } from "vitest";
import { ApiError, errorMessage, parseJsonBody, UNEXPECTED_RESPONSE } from "./api";

describe("parseJsonBody", () => {
  it("parses valid JSON", () => {
    expect(parseJsonBody<number[]>("[1,2]")).toEqual([1, 2]);
  });
  it.each(["", "   ", "<html>"])("throws a generic error for %j", (body) => {
    try {
      parseJsonBody(body, 200);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as Error).message).toBe(UNEXPECTED_RESPONSE);
    }
  });
});

describe("errorMessage body parsing", () => {
  it("uses the { error } field", () => {
    expect(errorMessage(500, '{"error":"boom"}')).toBe("Request failed (500): boom");
  });
  it("falls back to raw text for non-JSON or other shapes", () => {
    expect(errorMessage(500, "<html>")).toBe("Request failed (500): <html>");
    expect(errorMessage(500, '{"x":1}')).toBe('Request failed (500): {"x":1}');
    expect(errorMessage(500, "")).toBe("Request failed (500)");
  });
});
