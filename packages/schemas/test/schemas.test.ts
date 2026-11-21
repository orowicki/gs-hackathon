import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  unlink,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromYaml, watchConfigDir } from "@alerting/config";
import type { ConfigStore, Kind } from "@alerting/config";
import { evaluate, parse } from "@alerting/filter";
import {
  classifyEvent,
  createSchemaRegistry,
  mapCommonFields,
  matchSchema,
  normaliseTimestamp,
  normaliseValue,
  type SchemaDef as Schema,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const loadYaml = async (f: string) =>
  fromYaml(await readFile(join(root, "config/schemas", f), "utf8")) as Schema;
const loadEvent = async (f: string) =>
  JSON.parse(
    await readFile(join(root, "fixtures/events", f), "utf8"),
  ) as unknown;

const seeds = [
  {
    yaml: "workflow-failed.yaml",
    event: "workflow-failed.json",
    id: "schema-workflow-failed",
    common: {
      severity: "error",
      title: "order-settlement failed at validate-counterparty",
      source: "order-settlement",
      environment: "prod",
      dedupKey: "order-settlement-validate-counterparty",
      sourceStatus: "firing",
      occurredAt: "2026-10-23T09:14:02.331Z",
      type: "WORKFLOW_FAILED",
      message: "Counterparty service did not respond in 5000 ms",
      entity: "WF-20261023-00042",
    },
  },
  {
    yaml: "metric-breach.yaml",
    event: "metric-breach.json",
    id: "schema-metric-breach",
    common: {
      severity: "critical",
      title: "HighErrorRate on payments-api",
      source: "payments-api",
      environment: "prod",
      dedupKey: "HighErrorRate-payments-api",
      sourceStatus: "firing",
      occurredAt: "2026-10-23T09:13:00.000Z",
      type: "HighErrorRate",
      message: "Error rate 12% over the last 5 minutes",
    },
  },
  {
    yaml: "trade-rejected.yaml",
    event: "trade-rejected.json",
    id: "schema-trade-rejected",
    common: {
      severity: "info",
      title: "Rejected EUR 25000000 — LIMIT_BREACH",
      source: "trade-gateway",
      environment: "prod",
      dedupKey: "T-998877",
      sourceStatus: "firing",
      occurredAt: new Date(1792833245000).toISOString(),
      type: "trade.rejected.v2",
      message: "LIMIT_BREACH",
      entity: "T-998877",
    },
  },
] as const;

describe("seeded schemas", () => {
  for (const s of seeds) {
    it(`${s.yaml} maps ${s.event} exactly`, async () => {
      const schema = await loadYaml(s.yaml);
      expect(schema.id).toBe(s.id);
      expect(mapCommonFields(await loadEvent(s.event), schema)).toEqual(
        s.common,
      );
    });
  }
  it("each schema matches only its own fixture", async () => {
    const schemas = await Promise.all(seeds.map((s) => loadYaml(s.yaml)));
    for (const s of seeds) {
      const ev = await loadEvent(s.event);
      for (const schema of schemas) {
        expect(matchSchema(ev, [schema]) !== undefined).toBe(
          schema.id === s.id,
        );
      }
      expect(classifyEvent(ev, schemas).schemaId).toBe(s.id);
    }
  });
});

const mk = (
  id: string,
  match: Schema["match"],
  mapping: Schema["mapping"] = {},
): Schema => ({ id, name: id, match, mapping });

describe("mapCommonFields", () => {
  const ev = {
    a: [{ b: "x" }],
    n: 5,
    w: "wf",
    st: "s1",
    sev: "WARN",
    state: "RESOLVED",
  };
  it("path incl. array index, constant, template, default", () => {
    const c = mapCommonFields(
      ev,
      mk("s", "", {
        title: { kind: "path", path: "a.0.b" },
        source: { kind: "constant", value: "k" },
        dedupKey: { kind: "template", template: "{{w}}-{{st}}-{{n}}" },
        environment: { kind: "path", path: "missing", default: "dev" },
      }),
    );
    expect(c).toEqual({
      severity: "info",
      title: "x",
      source: "k",
      dedupKey: "wf-s1-5",
      environment: "dev",
    });
  });
  it("template with a missing placeholder is missing (default applies, else omitted)", () => {
    const t = (d?: string) =>
      mapCommonFields(
        ev,
        mk("s", "", {
          title: { kind: "template", template: "{{w}}-{{nope}}", default: d },
        }),
      ).title;
    expect(t()).toBeUndefined();
    expect(t("dflt")).toBe("dflt");
  });
  it("valueMap exact then case-insensitive", () => {
    const m = { ERROR: "critical", error: "warning" };
    const sev = (v: string) =>
      mapCommonFields(
        { s: v },
        mk("s", "", { severity: { kind: "path", path: "s", valueMap: m } }),
      ).severity;
    expect(sev("ERROR")).toBe("critical");
    expect(sev("error")).toBe("warning");
    expect(sev("Error")).toBe("critical");
  });
  it("severity normalisation and default", () => {
    const sev = (v: unknown) =>
      mapCommonFields(
        { s: v },
        mk("s", "", { severity: { kind: "path", path: "s" } }),
      ).severity;
    expect(sev("ERROR")).toBe("error");
    expect(sev("warn")).toBe("warning");
    expect(sev("crit")).toBe("critical");
    expect(sev("bogus")).toBe("info");
    expect(mapCommonFields({}, mk("s", "")).severity).toBe("info");
  });
  it("status normalisation, unknown omitted", () => {
    const st = (v: string) =>
      mapCommonFields(
        { s: v },
        mk("s", "", { sourceStatus: { kind: "path", path: "s" } }),
      ).sourceStatus;
    expect(st("RESOLVED")).toBe("resolved");
    expect(st("weird")).toBeUndefined();
  });
  it("legacy `status` key is an alias of sourceStatus; sourceStatus wins; output never has status", () => {
    const legacy = mapCommonFields(
      { s: "RESOLVED" },
      mk("s", "", { status: { kind: "path", path: "s" } }),
    );
    expect(legacy.sourceStatus).toBe("resolved");
    expect(legacy).not.toHaveProperty("status");
    const both = mapCommonFields(
      { s: "resolved", t: "firing" },
      mk("s", "", {
        status: { kind: "path", path: "s" },
        sourceStatus: { kind: "path", path: "t" },
      }),
    );
    expect(both.sourceStatus).toBe("firing");
    expect(both).not.toHaveProperty("status");
  });
  it("optional fields type/message/entity/runbookUrl map like the others and are absent when unmapped", () => {
    const c = mapCommonFields(
      { a: "A", o: { m: "msg" }, id: 7 },
      mk("s", "", {
        type: { kind: "path", path: "a" },
        message: { kind: "path", path: "o.m" },
        entity: { kind: "template", template: "e-{{id}}" },
        runbookUrl: { kind: "path", path: "nope", default: "http://rb" },
      }),
    );
    expect(c).toMatchObject({
      type: "A",
      message: "msg",
      entity: "e-7",
      runbookUrl: "http://rb",
    });
    const none = mapCommonFields({ a: "A" }, mk("s", ""));
    for (const k of ["type", "message", "entity", "runbookUrl", "sourceStatus"])
      expect(none).not.toHaveProperty(k);
  });
  it("metric-breach optional instance and runbook map when present", async () => {
    const schema = await loadYaml("metric-breach.yaml");
    const ev = JSON.parse(
      JSON.stringify(await loadEvent("metric-breach.json")),
    ) as {
      labels: Record<string, string>;
      annotations: Record<string, string>;
    };
    ev.labels.instance = "pay-1";
    ev.annotations.runbook_url = "https://wiki/rb";
    expect(mapCommonFields(ev, schema)).toMatchObject({
      entity: "pay-1",
      runbookUrl: "https://wiki/rb",
    });
  });
  it("occurredAt: ISO, epoch s, epoch ms, numeric strings", () => {
    const iso = "2026-10-23T09:13:00.000Z";
    const ms = Date.parse(iso);
    for (const v of [
      iso,
      "2026-10-23T09:13:00Z",
      ms,
      ms / 1000,
      String(ms),
      String(ms / 1000),
    ]) {
      expect(normaliseTimestamp(v)).toBe(iso);
    }
    expect(normaliseTimestamp("nope")).toBeUndefined();
    const c = mapCommonFields(
      { t: ms / 1000 },
      mk("s", "", { occurredAt: { kind: "path", path: "t" } }),
    );
    expect(c.occurredAt).toBe(iso);
  });
  it("occurredAt: short digit strings are omitted, not 1970", () => {
    for (const v of ["2026", "20261023", "12345678", "1.5"])
      expect(normaliseTimestamp(v)).toBeUndefined();
    expect(normaliseTimestamp("1700000000")).toBe("2023-11-14T22:13:20.000Z");
    expect(normaliseTimestamp("1700000000000")).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });
  it("occurredAt honours valueMap", () => {
    const c = mapCommonFields(
      { t: "never" },
      mk("s", "", {
        occurredAt: {
          kind: "path",
          path: "t",
          valueMap: { never: "2026-10-23T09:13:00Z" },
        },
      }),
    );
    expect(c.occurredAt).toBe("2026-10-23T09:13:00.000Z");
  });
  it("normaliseValue only converts canonical decimals", () => {
    for (const v of [
      "007",
      "+1",
      "1e3",
      " 5",
      "5 ",
      "-0",
      "0x10",
      "12345678901234567890",
      "1.",
      ".5",
      "NaN",
    ]) {
      expect(normaliseValue(v)).toBe(v);
    }
    expect(normaliseValue("0")).toBe(0);
    expect(normaliseValue("-3")).toBe(-3);
    expect(normaliseValue("0.25")).toBe(0.25);
  });
  it("normaliseValue", () => {
    expect(normaliseValue("12.5")).toBe(12.5);
    expect(normaliseValue("abc")).toBe("abc");
    expect(normaliseValue("")).toBe("");
    expect(normaliseValue({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("matching", () => {
  it("first match wins, sorted by id", () => {
    const all = [mk("20-b", "x = 1"), mk("10-a", "x = 1"), mk("30-c", "")];
    expect(matchSchema({ x: 1 }, all)?.id).toBe("10-a");
    expect(matchSchema({ x: 2 }, all)?.id).toBe("30-c");
  });
  it("bad filter is skipped and reported; tree filters work", () => {
    const errs: string[] = [];
    const tree = { type: "cmp", field: "x", op: "=", value: 1 } as const;
    const all = [mk("1-bad", "x ="), mk("2-tree", tree)];
    expect(matchSchema({ x: 1 }, all, (_, id) => errs.push(id))?.id).toBe(
      "2-tree",
    );
    expect(errs).toEqual(["1-bad"]);
  });
  it("unmatched: schemaId null, common empty, raw filter still true", () => {
    const ev = { labels: { severity: "critical" }, amount: "1500000" };
    expect(classifyEvent(ev, [mk("a", "nope = 1")])).toEqual({
      schemaId: null,
      common: {},
      parsed: { labels: { severity: "critical" }, amount: 1500000 },
    });
    expect(
      evaluate(parse("labels.severity = critical AND amount > 1000000"), {
        event: ev,
      }),
    ).toBe(true);
  });
});

describe("automatic normalisation", () => {
  it("unmatched event is returned normalised and numeric filters work", () => {
    const r = classifyEvent({ n: "42", id: "007" }, []);
    expect(r.schemaId).toBeNull();
    expect((r.parsed as { n: unknown; id: unknown }).n).toBe(42);
    expect((r.parsed as { id: unknown }).id).toBe("007");
    expect(evaluate(parse("n > 40"), { event: r.parsed })).toBe(true);
  });
  it("schema match on numeric comparison over a numeric-string field", () => {
    const r = classifyEvent({ amount: "1500000", name: "x" }, [
      mk("a", "amount > 1000000", {
        title: { kind: "template", template: "{{name}}-{{amount}}" },
      }),
    ]);
    expect(r.schemaId).toBe("a");
    expect(r.common.title).toBe("x-1500000");
    expect(typeof r.common.title).toBe("string");
  });
  it("string literal equality still works against a normalised number", () => {
    const r = classifyEvent({ code: "42" }, []);
    expect(evaluate(parse('code = "42"'), { event: r.parsed })).toBe(true);
    expect(evaluate(parse("code = 42"), { event: r.parsed })).toBe(true);
  });
});

type Handler = (c: {
  kind: Kind;
  id: string;
  op: "upsert" | "delete";
}) => unknown;
function fakeStore() {
  const data = new Map<string, Schema>();
  const handlers = new Set<Handler>();
  const emit = (id: string, op: "upsert" | "delete") =>
    handlers.forEach((h) => void h({ kind: "schema", id, op }));
  const store = {
    data,
    async list(kind: Kind) {
      return (kind === "schema" ? [...data.values()] : []) as never;
    },
    async get(kind: Kind, id: string) {
      return (kind === "schema" ? data.get(id) : undefined) as never;
    },
    async upsert(kind: Kind, entity: unknown) {
      const e = entity as { id: string };
      if (kind !== "schema") return;
      data.set(e.id, e as Schema);
      emit(e.id, "upsert");
    },
    async delete(kind: Kind, id: string) {
      const had = kind === "schema" && data.delete(id);
      if (had) emit(id, "delete");
      return had;
    },
    async onChange(_k: Kind | "*", h: Handler) {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    async close() {},
  };
  return store satisfies ConfigStore & { data: Map<string, Schema> };
}

describe("registry live reload", () => {
  it("picks up new, changed and deleted schemas", async () => {
    const store = fakeStore();
    const errs: string[] = [];
    const reg = createSchemaRegistry(store, {
      onError: (_e, id) => errs.push(id ?? "?"),
    });
    await reg.ready;
    const ev = { kind: "k1", sev: "ERROR" };
    expect(reg.classify(ev).schemaId).toBeNull();
    await store.upsert(
      "schema",
      mk("s1", "kind = k1", { severity: { kind: "path", path: "sev" } }),
    );
    await store.upsert("schema", mk("bad", "kind ="));
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.classify(ev)).toEqual({
      schemaId: "s1",
      common: { severity: "error" },
      parsed: ev,
    });
    expect(errs).toContain("bad");
    await store.upsert(
      "schema",
      mk("s1", "kind = k1", {
        severity: { kind: "constant", value: "critical" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.classify(ev).common.severity).toBe("critical");
    await store.delete("schema", "s1");
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.classify(ev).schemaId).toBeNull();
    reg.close();
  });
});

describe("registry initial load failure", () => {
  it("ready rejects, then the next change event retries", async () => {
    const store = fakeStore();
    let fail = true;
    const list = store.list.bind(store);
    store.list = (async (k: Kind) => {
      if (fail) throw new Error("db down");
      return list(k);
    }) as typeof store.list;
    const errs: string[] = [];
    const reg = createSchemaRegistry(store, {
      onError: (e) => errs.push(e.message),
    });
    await expect(reg.ready).rejects.toThrow("db down");
    expect(errs).toContain("db down");
    expect(reg.schemas()).toEqual([]);
    fail = false;
    await store.upsert("schema", mk("s1", "kind = k1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.classify({ kind: "k1" }).schemaId).toBe("s1");
    reg.close();
  });
});

describe("registry with real watchConfigDir", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });
  it("a new YAML file is used by the next classify; deleting it stops matching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemas-"));
    dirs.push(dir);
    await mkdir(join(dir, "schemas"));
    const store = fakeStore();
    const w = watchConfigDir(store, dir, { debounceMs: 20, onError: () => {} });
    await w.ready;
    const reg = createSchemaRegistry(store);
    await reg.ready;
    const ev = JSON.parse(
      await readFile(
        join(root, "fixtures/events/workflow-failed.json"),
        "utf8",
      ),
    ) as unknown;
    expect(reg.classify(ev).schemaId).toBeNull();
    const file = join(dir, "schemas", "wf.yaml");
    await writeFile(
      file,
      await readFile(join(root, "config/schemas/workflow-failed.yaml"), "utf8"),
    );
    const until = async (want: string | null) => {
      for (let i = 0; i < 100 && reg.classify(ev).schemaId !== want; i++)
        await new Promise((r) => setTimeout(r, 30));
      expect(reg.classify(ev).schemaId).toBe(want);
    };
    await until("schema-workflow-failed");
    expect(reg.classify(ev).common.title).toBe(
      "order-settlement failed at validate-counterparty",
    );
    await unlink(file);
    await until(null);
    reg.close();
    await w.close();
  });
});
