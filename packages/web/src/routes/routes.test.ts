import { describe, expect, it } from "vitest";
import { collectRoutes, routes } from "./registry";
import type { RouteDef } from "./types";

const EXPECTED = [
  "/",
  "/alerts/:id",
  "/approvals",
  "/events",
  "/config/sources",
  "/config/sources/:id",
  "/config/sources/new",
  "/config/schemas",
  "/config/schemas/:id",
  "/config/schemas/new",
  "/rules",
  "/rules/new",
  "/rules/:id",
  "/config/people",
  "/config/runbooks",
  "/config/runbooks/:id",
  "/config/runbooks/new",
  "/config/channels",
  "/config/claude",
  "/settings/notifications",
  "*",
];

describe("route registry", () => {
  it("has unique paths and all expected routes", () => {
    const paths = routes.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect([...paths].sort()).toEqual([...EXPECTED].sort());
  });

  it("puts the fallback last", () => {
    expect(routes[routes.length - 1].path).toBe("*");
  });
});

describe("collectRoutes", () => {
  const m = (path: string, order?: number) => ({
    default: { path, element: null, order } as RouteDef,
  });

  it("sorts by order then path", () => {
    const out = collectRoutes({
      a: m("*", 1000),
      b: m("/z"),
      c: m("/a"),
      d: m("/first", 1),
    });
    expect(out.map((r) => r.path)).toEqual(["/first", "/a", "/z", "*"]);
  });

  it("throws on duplicate paths", () => {
    expect(() =>
      collectRoutes({ "./a.route.tsx": m("/x"), "./b.route.tsx": m("/x") }),
    ).toThrow(/Duplicate route path "\/x"/);
  });
});
