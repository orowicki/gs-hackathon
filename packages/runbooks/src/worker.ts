import { hostname } from "node:os";
import type { Redis } from "ioredis";
import { STREAM_ALERTS, type Alert, type AlertEvent, type Event } from "@alerting/shared";
import type { RunbookRegistry } from "./registry.js";
import type { Runner } from "./runner.js";

export interface RunbookWorkerOptions {
  redis: Redis;
  registry: Pick<RunbookRegistry, "match">;
  runner: Pick<Runner, "start">;
  loadAlert(id: string): Promise<Alert | undefined>;
  loadEvent(id: string): Promise<Event | undefined>;
  group?: string;
  consumer?: string;
  onError?: (err: unknown) => void;
}

/** Handles one AlertEvent: starts every matching automation runbook on "created". */
export function createAlertEventHandler(o: Pick<RunbookWorkerOptions, "registry" | "runner" | "loadAlert" | "loadEvent">) {
  return async function handleAlertEvent(evt: AlertEvent): Promise<void> {
    if (evt.kind !== "created") return;
    const alert = await o.loadAlert(evt.alertId);
    if (!alert) return;
    const event = await o.loadEvent(evt.eventId);
    for (const rb of o.registry.match({ alert, event })) {
      if (rb.type !== "automation") continue;
      await o.runner.start(rb, { alert, event });
    }
  };
}

type Entries = Array<[string, string[]]>;

export function startRunbookWorker(o: RunbookWorkerOptions): { close(): Promise<void> } {
  const group = o.group ?? "runbooks";
  const consumer = o.consumer ?? `${hostname()}-${process.pid}`;
  const onError = o.onError ?? (() => {});
  const handle = createAlertEventHandler(o);
  // Blocking reads get their own connection so they never stall other commands.
  const blocker = o.redis.duplicate();
  blocker.on("error", () => {});
  let stopping = false;

  async function readBatch(id: string, block: boolean): Promise<Entries> {
    const args: (string | number)[] = ["GROUP", group, consumer, "COUNT", 10];
    if (block) args.push("BLOCK", 2000);
    args.push("STREAMS", STREAM_ALERTS, id);
    const res = (await (blocker as unknown as { xreadgroup: (...a: unknown[]) => Promise<unknown> }).xreadgroup(...args)) as
      | Array<[string, Entries]>
      | null;
    return res?.[0]?.[1] ?? [];
  }

  async function process_(entries: Entries): Promise<void> {
    for (const [id, fields] of entries) {
      try {
        const i = fields.indexOf("data");
        if (i < 0) throw new Error(`entry ${id} has no data field`);
        await handle(JSON.parse(fields[i + 1]!) as AlertEvent);
      } catch (err) {
        onError(err);
      }
      await o.redis.xack(STREAM_ALERTS, group, id);
    }
  }

  const loop = (async () => {
    while (!stopping) {
      try {
        await o.redis.xgroup("CREATE", STREAM_ALERTS, group, "0", "MKSTREAM").catch((err: unknown) => {
          if (!String(err).includes("BUSYGROUP")) throw err;
        });
        for (let e = await readBatch("0", false); e.length > 0 && !stopping; e = await readBatch("0", false)) await process_(e);
        while (!stopping) await process_(await readBatch(">", true));
      } catch (err) {
        if (stopping) return;
        onError(err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();

  return {
    async close() {
      stopping = true;
      blocker.disconnect();
      await loop;
    },
  };
}
