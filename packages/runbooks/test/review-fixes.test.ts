import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { tryParse } from "@alerting/filter";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import {
  createActionRegistry,
  createMemoryRunStore,
  createRunbookRegistry,
  createRunbookRoutes,
  createRunner,
  httpAction,
  renderUrl,
  validateRunbook,
  type ActionContext,
  type StoredRun,
} from "../src/index.js";
import { renderTemplate } from "../src/template.js";
import { workflowAlert, workflowEvent } from "./helpers.js";

const template = { alert: workflowAlert() as Alert, event: workflowEvent() };
const ctx = (): ActionContext => ({
  template,
  render: (s) => renderTemplate(s, template),
  alertId: "a1",
  runbookId: "rb",
  stepIndex: 0,
});
const httpStep = (url: string, headers?: Record<string, string>) =>
  ({ action: "http", method: "GET", url, headers, approval: "none" }) as never;
const tpl = () => ({ alert: workflowAlert() as Alert });
const aid = workflowAlert().id;

describe("renderUrl", () => {
  it("encodes substitutions and rejects origin placeholders", () => {
    const t = { alert: { ...workflowAlert(), entity: "a/b?c" } as Alert };
    expect(renderUrl("http://h:1/x/{{alert.entity}}?q={{alert.entity}}", t)).toBe(
      `http://h:1/x/${encodeURIComponent("a/b?c")}?q=${encodeURIComponent("a/b?c")}`,
    );
    expect(() => renderUrl("http://{{alert.entity}}/x", t)).toThrow("placeholder not allowed in URL origin");
    expect(() => renderUrl("http://u:{{alert.entity}}@h/x", t)).toThrow("placeholder not allowed in URL origin");
    expect(() => renderUrl("{{alert.entity}}/x", t)).toThrow("placeholder not allowed in URL origin");
  });
});

describe("httpAction hardening", () => {
  it("fails a step with a placeholder in the origin", async () => {
    const fetch = vi.fn();
    const r = await httpAction({ fetch }).execute(httpStep("http://{{alert.id}}.evil/x"), ctx());
    expect(r.ok).toBe(false);
    expect(r.result).toContain("placeholder not allowed in URL origin");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strips CR/LF from header values and does not follow redirects", async () => {
    const seen: { headers?: Record<string, string>; redirect?: string } = {};
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      seen.headers = init.headers as Record<string, string>;
      seen.redirect = init.redirect;
      return new Response(null, { status: 302, headers: { location: "http://elsewhere/" } });
    });
    const r = await httpAction({ fetch: fetch as never }).execute(httpStep("http://h/x", { "x-a": "a\r\nx-evil: 1" }), ctx());
    expect(seen.headers?.["x-a"]).not.toMatch(/[\r\n]/);
    expect(seen.redirect).toBe("manual");
    expect(r).toEqual({ ok: false, result: "redirect to http://elsewhere/ not followed" });
  });

  it("reads at most 64 KiB and cancels the rest", async () => {
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 16 * 1024;
        c.enqueue(new Uint8Array(16 * 1024).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = async () => new Response(body, { status: 200 });
    const r = await httpAction({ fetch: fetch as never }).execute(httpStep("http://h/x"), ctx());
    expect(r.ok).toBe(true);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 32 * 1024);
    expect(r.result.length).toBeLessThan(300);
  });
});

describe("runner recovery and audit order", () => {
  const rb = (): AutomationRunbook => ({
    id: "rb1",
    name: "rb",
    type: "automation",
    matches: "",
    steps: [{ action: "t", name: "a", approval: "none" }, { action: "t", name: "b", approval: "none" }] as never,
  });
  const staleRun = (updatedAt: string): StoredRun => ({
    alertId: aid,
    runbookId: "rb1",
    steps: [{ index: 0, state: "running" }, { index: 1, state: "pending" }],
    runbook: rb(),
    template: tpl(),
    status: "running",
    version: 0,
    createdAt: updatedAt,
    updatedAt,
  });

  it("recoverStale fails stuck steps, skips the rest, audits as system", async () => {
    const store = createMemoryRunStore();
    const now = new Date("2026-01-01T01:00:00Z");
    await store.createRun(staleRun("2026-01-01T00:00:00Z"));
    const fresh = { ...staleRun("2026-01-01T00:59:00Z"), runbookId: "fresh", alertId: "other" };
    await store.createRun(fresh);
    const runner = createRunner({ store, actions: createActionRegistry([]), now: () => now });
    expect(await runner.recoverStale()).toBe(1);
    const [run] = await runner.listRuns(aid);
    expect(run!.status).toBe("failed");
    expect(run!.steps.map((s) => s.state)).toEqual(["failed", "skipped"]);
    expect(run!.steps[0]!.result).toBe("interrupted (process restarted)");
    const audit = await runner.listAudit({ alertId: aid });
    expect(audit.map((e) => [e.action, e.actor])).toEqual([
      ["step_executed", "system"],
      ["step_skipped", "system"],
    ]);
    expect((await store.getRun("other", "fresh"))!.status).toBe("running");
    expect(await runner.recoverStale()).toBe(0);
  });

  it("writes no audit entry when the CAS save fails", async () => {
    const inner = createMemoryRunStore();
    let saves = 0;
    const store = {
      ...inner,
      async updateRun(run: StoredRun) {
        // first save (state running) ok; second (step result) conflicts
        return ++saves === 1 ? inner.updateRun(run) : false;
      },
    };
    const runner = createRunner({
      store,
      actions: createActionRegistry([{ type: "t", execute: async () => ({ ok: true, result: "ok" }) }]),
    });
    await expect(runner.start(rb(), tpl())).rejects.toThrow();
    expect(await runner.listAudit({ alertId: aid })).toEqual([]);
  });
});

describe("validateRunbook wait cap", () => {
  const wait = (duration: string) => ({
    id: "w",
    name: "w",
    type: "automation",
    steps: [{ action: "wait", duration }],
  });
  it("rejects waits above the cap", () => {
    expect(validateRunbook(wait("15m")).ok).toBe(true);
    const r = validateRunbook(wait("16m"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds the maximum/);
    expect(validateRunbook(wait("2h"), { maxWaitMs: 3 * 3_600_000 }).ok).toBe(true);
  });
});

describe("approve responds 202 when the continuation is slow", () => {
  it("returns the current run state, then finishes in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = createMemoryRunStore();
    const runner = createRunner({
      store,
      actions: createActionRegistry([{ type: "t", execute: async () => (await gate, { ok: true, result: "ok" }) }]),
    });
    const rb: AutomationRunbook = {
      id: "rb1", name: "rb", type: "automation", matches: "",
      steps: [{ action: "t", name: "a", approval: "required" }] as never,
    };
    await runner.start(rb, tpl());
    const routes = createRunbookRoutes({ runner, respondWithinMs: 30 });
    const server = http.createServer((req, res) => {
      routes.handle(req, res, new URL(req.url ?? "/", "http://x")).then((h) => h || res.writeHead(404).end());
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/alerts/${aid}/runbook-steps/0/approve`, { method: "POST", body: "{}" });
      expect(res.status).toBe(202);
      expect(((await res.json()) as { steps: Array<{ state: string }> }).steps[0]!.state).toBe("running");
      release();
      await vi.waitFor(async () => expect((await store.getRun(aid, "rb1"))!.status).toBe("done"));
    } finally {
      server.close();
    }
  });
});

describe("registry resilience", () => {
  it("retries a failing onChange subscription and never rejects ready", async () => {
    let calls = 0;
    const errors: string[] = [];
    const store = {
      list: async () => [],
      onChange: async () => {
        if (++calls < 3) throw new Error("subscribe boom");
        return () => undefined;
      },
    };
    const reg = createRunbookRegistry(store as never, {
      onError: (e) => errors.push(e.message),
      retryBaseMs: 1,
      retryMaxMs: 4,
    });
    await reg.ready;
    expect(calls).toBe(3);
    expect(errors).toEqual(["subscribe boom", "subscribe boom"]);
    await reg.close();
  });

  it("close() stops retrying", async () => {
    const store = { list: async () => [], onChange: async () => Promise.reject(new Error("down")) };
    const reg = createRunbookRegistry(store as never, { onError: () => undefined, retryBaseMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await reg.close();
  });
});

describe("pg store ready/clamp", () => {
  it("waits for ready and clamps the audit limit", async () => {
    const { createPgRunStore } = await import("../src/index.js");
    const order: string[] = [];
    let open!: () => void;
    const ready = new Promise<void>((r) => (open = r));
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        order.push(`${sql.slice(0, 12)}|${JSON.stringify(params)}`);
        return { rows: [], rowCount: 0 };
      },
    };
    const store = createPgRunStore(pool as never, { ready });
    const p = store.listAudit({ limit: 5000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    open();
    await p;
    expect(order[0]).toContain("[1000]");
    await store.listAudit({ limit: 0 });
    expect(order[1]).toContain("[1]");
  });
});

describe("shipped config/runbooks", () => {
  const dir = new URL("../../../config/runbooks/", import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  it("has files", () => expect(files.length).toBeGreaterThan(0));
  it.each(files)("%s validates and its filter parses", (f) => {
    const v = validateRunbook(parse(readFileSync(new URL(f, dir), "utf8")));
    if (!v.ok) throw new Error(v.error);
    if (typeof v.runbook.matches === "string" && v.runbook.matches !== "") {
      expect(tryParse(v.runbook.matches).ok).toBe(true);
    }
  });
});
