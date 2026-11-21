import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import { createActionRegistry, createPgRunStore, createRunner, migrateRunbooks } from "../src/index.js";
import { workflowAlert } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("pg run store", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await Promise.all([migrateRunbooks(pool), migrateRunbooks(pool)]);
  });
  afterAll(() => pool.end());

  it("runs, CAS approve and audit", async () => {
    const alert = { ...(workflowAlert() as Alert), id: `it-${Date.now()}` };
    const rb: AutomationRunbook = {
      id: "rb", name: "rb", type: "automation", matches: "",
      steps: [{ action: "t", name: "x", approval: "required" } as never],
    };
    const runner = createRunner({
      store: createPgRunStore(pool),
      actions: createActionRegistry([{ type: "t", execute: async () => ({ ok: true, result: "ok" }) }]),
    });
    expect((await runner.start(rb, { alert })).status).toBe("awaiting_approval");
    expect((await runner.start(rb, { alert })).status).toBe("awaiting_approval");
    expect((await runner.listPendingApprovals()).some((p) => p.alertId === alert.id)).toBe(true);
    const res = await Promise.allSettled([
      runner.approve(alert.id, 0, { actor: "a", runbookId: "rb" }),
      runner.approve(alert.id, 0, { actor: "b", runbookId: "rb" }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const audit = await runner.listAudit({ alertId: alert.id });
    expect(audit.map((e) => e.action)).toEqual(["step_approved", "step_executed"]);
  });
});
