import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import type { RankingData } from "./data.js";
import { rankEntries, renderPage } from "./page.js";

let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  server = createServer({ checkPostgres: async () => true, checkRedis: async () => true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const entry = (login: string, mergedPrs: number, title = "t") => ({
  login, mergedPrs, linesAdded: 100, linesRemoved: 10, issuesClosed: 1,
  firstMerge: "2026-01-01T00:00:00Z", lastMerge: "2026-01-02T00:00:00Z", biggestPr: { number: 1, title, lines: 110 },
});

describe("ranking page", () => {
  it("serves html with all three autopilots and json data", async () => {
    const res = await fetch(`${base}/ranking`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const l of ["orowicki", "mguszczin", "igorstec"]) expect(html).toContain(l);
    const api = (await (await fetch(`${base}/api/ranking`)).json()) as { ranking: unknown[] };
    expect(api.ranking).toHaveLength(3);
  });

  it("sorts by score and escapes titles", () => {
    const data: RankingData = { generatedAt: "2026-01-01T00:00:00Z", repo: "a/b", entries: [entry("low", 1), entry("high", 9, "<script>alert(1)</script>")] };
    expect(rankEntries(data).map((e) => e.login)).toEqual(["high", "low"]);
    const html = renderPage(data);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&#60;script&#62;");
  });

  it("does not handle other paths or methods", async () => {
    expect((await fetch(`${base}/rankings`)).status).toBe(404);
    expect((await fetch(`${base}/ranking`, { method: "POST" })).status).toBe(404);
  });
});
