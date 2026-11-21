import type { ConfigStore } from "@alerting/config";
import type { Group, Person, Preference } from "@alerting/shared";
import type { Logger } from "../rules/compile.js";

export interface Directory {
  ready: Promise<void>;
  person(id: string): Person | undefined;
  group(id: string): Group | undefined;
  preference(ownerType: "person" | "group", ownerId: string): Preference | undefined;
  close(): void;
}

export function prefId(ownerType: string, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

/** Fixed directory, for tests and one-shot tools. */
export function createStaticDirectory(data: {
  people?: Person[];
  groups?: Group[];
  preferences?: Preference[];
}): Directory {
  const people = new Map((data.people ?? []).map((p) => [p.id, p]));
  const groups = new Map((data.groups ?? []).map((g) => [g.id, g]));
  const prefs = new Map((data.preferences ?? []).map((p) => [prefId(p.ownerType, p.ownerId), p]));
  return {
    ready: Promise.resolve(),
    person: (id) => people.get(id),
    group: (id) => groups.get(id),
    preference: (t, id) => prefs.get(prefId(t, id)),
    close() {},
  };
}

/** Directory kept live from the config store via onChange. */
export function createDirectory(store: ConfigStore, opts: { logger?: Logger } = {}): Directory {
  const logger = opts.logger ?? console;
  const people = new Map<string, Person>();
  const groups = new Map<string, Group>();
  const prefs = new Map<string, Preference>();
  const unsubs: Array<() => void> = [];
  let closed = false;

  const track = async <T>(
    kind: "person" | "group" | "preference",
    map: Map<string, T>,
    key: (e: T) => string,
  ) => {
    const u = await store.onChange(kind, async (change) => {
      if (closed) return;
      try {
        if (change.op === "delete") map.delete(change.id);
        else {
          const e = (await store.get(kind, change.id)) as T | undefined;
          if (e) map.set(change.id, e);
          else map.delete(change.id);
        }
      } catch (err) {
        logger.error(`directory: failed to apply ${kind} change ${change.id}: ${(err as Error).message}`);
      }
    });
    if (closed) u();
    else unsubs.push(u);
    const all = (await store.list(kind)) as unknown as T[];
    for (const e of all) if (!map.has(key(e))) map.set(key(e), e);
  };

  const ready = (async () => {
    await track("person", people, (p: Person) => p.id);
    await track("group", groups, (g: Group) => g.id);
    await track("preference", prefs, (p: Preference) => prefId(p.ownerType, p.ownerId));
  })();

  return {
    ready,
    person: (id) => people.get(id),
    group: (id) => groups.get(id),
    preference: (t, id) => prefs.get(prefId(t, id)),
    close() {
      closed = true;
      for (const u of unsubs) u();
    },
  };
}
