import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { Event } from "@alerting/shared";
import { createServer, type Deps } from "../src/server.js";
import {
  createMemoryEventList,
  createPgEventList,
} from "../src/routes/events/list.js";

const base: Deps = {
  checkPostgres: async () => true,
  checkRedis: async () => true,
};
let server: http.Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((r) => server!.close(r));
  server = undefined;
});

const mk = (i: number, extra: Partial<Event> = {}, prefix = "e"): Event => ({
  id: `${prefix}${i}`,
  sourceId: "src",
  receivedAt: `2026-10-23T09:${String(10 + i).padStart(2, "0")}:00.000Z`,
  raw: { n: i },
  parsed: { n: i, level: i % 2 ? "odd" : "even" },
  schemaId: null,
  common: {},
  ...extra,
});
const all = [0, 1, 2, 3, 4].map((i) => mk(i));

async function start(extra: Partial<Deps> = {}) {
  server = createServer({
    ...base,
    eventList: createMemoryEventList(all),
    ...extra,
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (q = "") => {
    const r = await fetch(`${url}/api/events${q}`);
    return {
      status: r.status,
      next: r.headers.get("x-next-before"),
      body: (await r.json()) as never as Event[] & {
        error: string;
        position: number;
      },
    };
  };
}
const ids = (b: Event[]) => b.map((e) => e.id);

describe("GET /api/events", () => {
  it("503 without a store", async () => {
    server = createServer(base);
    await new Promise<void>((r) => server!.listen(0, r));
    const r = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`,
    );
    expect(r.status).toBe(503);
  });

  it("newest first, no cursor when everything fits", async () => {
    const get = await start();
    const r = await get();
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual(["e4", "e3", "e2", "e1", "e0"]);
    expect(r.next).toBeNull();
  });

  it("limit and paging via x-next-before", async () => {
    const get = await start();
    const seen: string[] = [];
    let q = "?limit=2";
    for (let i = 0; i < 5; i++) {
      const r = await get(q);
      seen.push(...ids(r.body));
      if (!r.next) break;
      q = `?limit=2&before=${encodeURIComponent(r.next)}`;
    }
    expect(seen).toEqual(["e4", "e3", "e2", "e1", "e0"]);
  });

  it("breaks receivedAt ties by id", async () => {
    const t = "2026-10-23T09:00:00.000Z";
    const get = await start({
      eventList: createMemoryEventList([
        mk(1, { receivedAt: t }),
        mk(2, { receivedAt: t }),
        mk(3, { receivedAt: t }),
      ]),
    });
    const p1 = await get("?limit=2");
    expect(ids(p1.body)).toEqual(["e3", "e2"]);
    const p2 = await get(`?limit=2&before=${encodeURIComponent(p1.next!)}`);
    expect(ids(p2.body)).toEqual(["e1"]);
  });

  it("filters", async () => {
    const get = await start();
    const r = await get(`?filter=${encodeURIComponent('level = "odd"')}`);
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual(["e3", "e1"]);
    const paged = await get(
      `?limit=1&filter=${encodeURIComponent('level = "even"')}`,
    );
    expect(ids(paged.body)).toEqual(["e4"]);
    expect(paged.next).toBeTruthy();
    const next = await get(
      `?limit=1&filter=${encodeURIComponent('level = "even"')}&before=${encodeURIComponent(paged.next!)}`,
    );
    expect(ids(next.body)).toEqual(["e2"]);
  });

  it("bad filter -> 400 with position", async () => {
    const get = await start();
    const r = await get(`?filter=${encodeURIComponent("level = ")}`);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
    expect(typeof r.body.position).toBe("number");
  });

  it("bad cursor -> 400; limit is clamped", async () => {
    const get = await start();
    expect((await get("?before=%21%21")).status).toBe(400);
    expect((await get("?limit=2")).body).toHaveLength(2);
    expect((await get("?limit=0")).body).toHaveLength(1);
    expect((await get("?limit=9999")).body).toHaveLength(5);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("createPgEventList", () => {
  it("lists newest first with a stable cursor", async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const prefix = `t108-${Date.now()}-`;
    try {
      await pool.query(
        readFileSync(
          new URL(
            "../../ingest/migrations/ingest_001_events.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const evs = [0, 1, 2].map((i) =>
        mk(i, { receivedAt: `2099-01-01T00:0${i}:00.123Z` }, prefix),
      );
      for (const e of evs)
        await pool.query(
          "INSERT INTO events (id, source_id, received_at, raw, parsed, schema_id, common) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            e.id,
            e.sourceId,
            e.receivedAt,
            JSON.stringify(e.raw),
            JSON.stringify(e.parsed),
            e.schemaId,
            JSON.stringify(e.common),
          ],
        );
      const store = createPgEventList(pool);
      const p1 = await store.list({ limit: 2 });
      expect(p1).toEqual([evs[2], evs[1]]);
      const p2 = await store.list({
        before: { receivedAt: p1[1]!.receivedAt, id: p1[1]!.id },
        limit: 2,
      });
      expect(p2[0]).toEqual(evs[0]);
    } finally {
      await pool.query("DELETE FROM events WHERE id LIKE $1", [`${prefix}%`]);
      await pool.end();
    }
  });
});
