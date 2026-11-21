import type { ConfigStore } from "@alerting/config";
import type { Alert, Event, Runbook } from "@alerting/shared";
import { matchRunbooks, validateRunbook } from "./match.js";

export interface RunbookRegistry {
  ready: Promise<void>;
  all(): Runbook[];
  get(id: string): Runbook | undefined;
  match(ctx: { alert: Alert; event?: Event }): Runbook[];
  close(): Promise<void>;
}

export function createRunbookRegistry(
  store: Pick<ConfigStore, "list" | "onChange">,
  opts: { onError?: (err: Error, id?: string) => void } = {},
): RunbookRegistry {
  const items = new Map<string, Runbook>();
  const report = (err: unknown, id?: string) => opts.onError?.(err instanceof Error ? err : new Error(String(err)), id);

  const reload = async () => {
    try {
      const list = await store.list("runbook");
      items.clear();
      for (const raw of list) {
        const r = validateRunbook(raw);
        if (r.ok) items.set(r.runbook.id, r.runbook);
        else report(new Error(`invalid runbook ${(raw as { id?: string })?.id ?? "?"}: ${r.error}`), (raw as { id?: string })?.id);
      }
    } catch (err) {
      report(err);
    }
  };

  // Serialise reloads so the last change always wins.
  let chain: Promise<void> = Promise.resolve();
  const schedule = () => (chain = chain.then(reload));

  let unsub: (() => void) | undefined;
  let closed = false;
  const ready = (async () => {
    unsub = await store.onChange("runbook", () => {
      if (!closed) return schedule();
    });
    await schedule();
  })();

  return {
    ready,
    all: () => [...items.values()],
    get: (id) => items.get(id),
    match: (ctx) => matchRunbooks([...items.values()], ctx),
    async close() {
      closed = true;
      await ready.catch(() => undefined);
      unsub?.();
      await chain;
    },
  };
}
