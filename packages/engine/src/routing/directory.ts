import type { ConfigStore } from "@alerting/config";
import type { Group, Person, Preference } from "@alerting/shared";
import { trackConfig, type LiveTracker } from "../live.js";
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
  const trackers: LiveTracker[] = [];

  const track = <T>(
    kind: "person" | "group" | "preference",
    map: Map<string, T>,
    key: (e: T) => string,
  ) => {
    const t = trackConfig(store, kind, {
      logger,
      label: "directory",
      idOf: (e) => key(e as T),
      put(id, entity) {
        if (entity) map.set(id, entity as T);
        else map.delete(id);
      },
    });
    trackers.push(t);
    return t.ready;
  };

  const ready = Promise.all([
    track("person", people, (p: Person) => p.id),
    track("group", groups, (g: Group) => g.id),
    track("preference", prefs, (p: Preference) => prefId(p.ownerType, p.ownerId)),
  ]).then(() => undefined);

  return {
    ready,
    person: (id) => people.get(id),
    group: (id) => groups.get(id),
    preference: (t, id) => prefs.get(prefId(t, id)),
    close() {
      for (const t of trackers) t.close();
    },
  };
}
