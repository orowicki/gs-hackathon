import type { IncomingMessage, ServerResponse } from "node:http";
import type { Alert, Event, RunbookRun } from "@alerting/shared";
import { RunnerError, type Runner } from "./runner.js";
import type { RunbookRegistry } from "./registry.js";
import type { StoredRun } from "./store.js";
import { stepDisplayName } from "./actions.js";
import { renderTemplate } from "./template.js";

/** A runbook that applies to an alert, ready to show: text filled in, step names rendered. */
export interface MatchedRunbook {
  id: string;
  name: string;
  type: "text" | "automation";
  /** "rule" = the alert rule's own runbook (written on the alert page), "config" = a shared one. */
  origin: "rule" | "config";
  content?: string;
  steps?: Array<{ index: number; name: string; action: string; approval: string }>;
}

export interface RunbookRoutesDeps {
  runner: Runner;
  registry?: Pick<RunbookRegistry, "get"> & Partial<Pick<RunbookRegistry, "match">>;
  /** Needed for POST /api/alerts/{id}/runbook-runs (start a runbook by hand); omitted = that route 404s. */
  loadAlert?(id: string): Promise<Alert | undefined>;
  loadEvent?(id: string): Promise<Event | undefined>;
  /** How long approve waits for the continuation before answering 202 (default 5000). */
  respondWithinMs?: number;
}

export type PublicRun = RunbookRun & {
  status: StoredRun["status"];
  runbookName?: string;
  steps: Array<RunbookRun["steps"][number] & { name?: string }>;
};

const MAX_BODY = 64 * 1024;

/** Public view of a run: no template or runbook snapshot. */
export function toPublicRun(run: StoredRun): PublicRun {
  return {
    alertId: run.alertId,
    runbookId: run.runbookId,
    runbookName: run.runbook.name,
    status: run.status,
    steps: run.steps.map((s) => {
      const def = run.runbook.steps[s.index];
      return { ...s, name: def ? stepDisplayName(def, run.template) : undefined };
    }),
  };
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large", "too_large");
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body", "bad_request");
  }
}

export function createRunbookRoutes(deps: RunbookRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
} {
  const { runner } = deps;
  const respondWithinMs = deps.respondWithinMs ?? 5000;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new HttpError(400, "bad path encoding", "bad_request");
    }
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? "GET";
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/api/approvals") {
      send(res, 200, await runner.listPendingApprovals());
      return true;
    }
    if (method === "GET" && (m = /^\/api\/alerts\/([^/]+)\/runbook-runs$/.exec(path))) {
      send(res, 200, (await runner.listRuns(dec(m[1]!))).map(toPublicRun));
      return true;
    }
    if (method === "GET" && (m = /^\/api\/alerts\/([^/]+)\/runbooks$/.exec(path))) {
      if (!deps.registry?.match || !deps.loadAlert) throw new HttpError(404, "runbook matching is not available", "not_found");
      const alert = await deps.loadAlert(dec(m[1]!));
      if (!alert) throw new HttpError(404, "alert not found", "not_found");
      const event = deps.loadEvent ? await deps.loadEvent(alert.eventId) : undefined;
      const ctx = { alert, event };
      const out: MatchedRunbook[] = deps.registry.match(ctx).map((rb) => {
        const origin = (rb as { ruleId?: unknown }).ruleId === alert.ruleId ? "rule" : "config";
        return rb.type === "text"
          ? { id: rb.id, name: rb.name, type: "text", origin, content: renderTemplate(rb.content, ctx) }
          : {
              id: rb.id,
              name: rb.name,
              type: "automation",
              origin,
              steps: rb.steps.map((st, index) => ({
                index,
                name: stepDisplayName(st, ctx),
                action: st.action,
                approval: st.approval ?? "none",
              })),
            };
      });
      // The rule's own runbook first.
      out.sort((a, b) => (a.origin === b.origin ? 0 : a.origin === "rule" ? -1 : 1));
      send(res, 200, out);
      return true;
    }
    if (method === "POST" && (m = /^\/api\/alerts\/([^/]+)\/runbook-runs$/.exec(path))) {
      if (!deps.registry || !deps.loadAlert) throw new HttpError(404, "starting runbooks is not available", "not_found");
      const alertId = dec(m[1]!);
      const body = await readBody(req);
      const runbookId = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).runbookId : undefined;
      if (typeof runbookId !== "string" || !runbookId) throw new HttpError(400, "runbookId must be a non-empty string", "bad_request");
      const rb = deps.registry.get(runbookId);
      if (!rb) throw new HttpError(404, `runbook not found: ${runbookId}`, "not_found");
      if (rb.type !== "automation") throw new HttpError(400, "only automation runbooks can be run; text runbooks are instructions", "bad_request");
      const alert = await deps.loadAlert(alertId);
      if (!alert) throw new HttpError(404, "alert not found", "not_found");
      const event = deps.loadEvent ? await deps.loadEvent(alert.eventId) : undefined;
      // Same as approve: answer once the first steps are done or after respondWithinMs, whichever is first.
      const pending = runner.start(rb, { alert, event });
      let timer: NodeJS.Timeout | undefined;
      const timedOut = Symbol("timeout");
      const first = await Promise.race([
        pending,
        new Promise<typeof timedOut>((r) => {
          timer = setTimeout(() => r(timedOut), respondWithinMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (first !== timedOut) {
        send(res, 200, toPublicRun(first));
        return true;
      }
      pending.catch((e: unknown) => console.error("runbook start failed:", e));
      const cur = (await runner.listRuns(alertId)).find((r) => r.runbookId === rb.id);
      send(res, 202, cur ? toPublicRun(cur) : { alertId, runbookId: rb.id, status: "running", steps: [] });
      return true;
    }
    if (method === "POST" && (m = /^\/api\/alerts\/([^/]+)\/runbook-steps\/([^/]+)\/approve$/.exec(path))) {
      const alertId = dec(m[1]!);
      const rawIdx = dec(m[2]!);
      if (!/^\d+$/.test(rawIdx)) throw new HttpError(400, "stepIndex must be a non-negative integer", "bad_request");
      const stepIndex = Number(rawIdx);
      const body = await readBody(req);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "body must be a JSON object", "bad_request");
      }
      const b = body as Record<string, unknown>;
      for (const k of ["actor", "runbookId", "decision"]) {
        if (b[k] !== undefined && typeof b[k] !== "string") throw new HttpError(400, `${k} must be a string`, "bad_request");
      }
      const decision = (b.decision as string | undefined) ?? "approve";
      if (decision !== "approve" && decision !== "skip") throw new HttpError(400, "decision must be approve or skip", "bad_request");
      const runbookId = (b.runbookId as string | undefined) || url.searchParams.get("runbookId") || undefined;
      const pending = runner.approve(alertId, stepIndex, {
        actor: (b.actor as string | undefined) || url.searchParams.get("actor") || "anonymous",
        runbookId,
        decision,
      });
      let timer: NodeJS.Timeout | undefined;
      const timedOut = Symbol("timeout");
      const first = await Promise.race([
        pending,
        new Promise<typeof timedOut>((r) => {
          timer = setTimeout(() => r(timedOut), respondWithinMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (first !== timedOut) {
        send(res, 200, toPublicRun(first));
        return true;
      }
      pending.catch((e: unknown) => console.error("runbook continuation failed:", e));
      const runs = await runner.listRuns(alertId);
      const cur =
        runs.find((r) => (runbookId === undefined || r.runbookId === runbookId) && r.steps[stepIndex]?.state === "running") ??
        runs.find((r) => runbookId === undefined || r.runbookId === runbookId);
      if (!cur) throw new HttpError(404, "run not found", "not_found");
      send(res, 202, toPublicRun(cur));
      return true;
    }
    return false;
  }

  return {
    async handle(req, res, url) {
      try {
        return await route(req, res, url);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.message, code: e.code });
        else if (e instanceof RunnerError) send(res, e.code === "not_found" ? 404 : 409, { error: e.message, code: e.code });
        else send(res, 500, { error: "internal error", code: "internal" });
        return true;
      }
    },
  };
}
