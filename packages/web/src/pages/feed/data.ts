import type { Alert, Person, StarredFilter, UiPush } from "@alerting/shared";
import { sortAlerts } from "./helpers";

export type PushMessage = UiPush | { type: string };

export interface FeedSource {
  listAlerts(): Promise<Alert[]>;
  getAlert(id: string): Promise<Alert>;
  /** Returns an unsubscribe function. */
  subscribe(onPush: (p: PushMessage) => void, onStatus: (live: boolean) => void): () => void;
  listPeople(): Promise<Person[]>;
  getStarred(personId: string): Promise<StarredFilter[]>;
  putStarred(personId: string, list: StarredFilter[]): Promise<StarredFilter[]>;
  suggestFields?(): Promise<string[]>;
  /** Acknowledge an alert; returns the updated alert. */
  ack?(id: string): Promise<Alert>;
  /** True when the data is the built-in fixture mock, not a real API. */
  demo?: boolean;
}

export const ALERTS_URL = "/api/alerts?limit=200";

const NO_BACKEND = [404, 502, 503, 504];

export type Probe = { ok: true; alerts: Alert[] } | { ok: false };

/** First GET /api/alerts. A 404/502/503/504 (proxy without backend), a non-JSON body or a network error means there is no API: use the mock. */
export async function probeApi(fetchFn: typeof fetch): Promise<Probe> {
  let res: Response;
  try {
    res = await fetchFn(ALERTS_URL);
  } catch {
    return { ok: false };
  }
  if (NO_BACKEND.includes(res.status)) return { ok: false };
  if (!res.ok) throw new Error("GET /api/alerts failed with " + res.status);
  try {
    const body: unknown = await res.json();
    return Array.isArray(body) ? { ok: true, alerts: body as Alert[] } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function json<T>(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error((init?.method ?? "GET") + " " + url + " failed with " + res.status);
  return (await res.json()) as T;
}

export function createHttpSource(first: Alert[], fetchFn: typeof fetch = (...a) => fetch(...a)): FeedSource {
  let primed: Alert[] | null = first;
  const starredUrl = (id: string) => "/api/people/" + encodeURIComponent(id) + "/starred-filters";
  return {
    async listAlerts() {
      if (primed) {
        const a = primed;
        primed = null;
        return sortAlerts(a);
      }
      return sortAlerts(await json<Alert[]>(fetchFn, ALERTS_URL));
    },
    getAlert: (id) => json<Alert>(fetchFn, "/api/alerts/" + encodeURIComponent(id)),
    ack: (id) => json<Alert>(fetchFn, "/api/alerts/" + encodeURIComponent(id) + "/ack", { method: "POST" }),
    subscribe(onPush, onStatus) {
      const es = new EventSource("/api/stream");
      es.onopen = () => onStatus(true);
      es.onerror = () => onStatus(false);
      es.onmessage = (e: MessageEvent<string>) => {
        try {
          const msg: unknown = JSON.parse(e.data);
          if (msg && typeof msg === "object" && typeof (msg as { type?: unknown }).type === "string") onPush(msg as PushMessage);
        } catch {
          /* ignore malformed frames */
        }
      };
      return () => es.close();
    },
    listPeople: () => json<Person[]>(fetchFn, "/api/people"),
    getStarred: (id) => json<StarredFilter[]>(fetchFn, starredUrl(id)),
    putStarred: (id, list) =>
      json<StarredFilter[]>(fetchFn, starredUrl(id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(list),
      }),
    async suggestFields() {
      try {
        const r = await json<unknown>(fetchFn, "/api/filters/suggest");
        return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    },
  };
}

/** True when the source serves fixture data and the page should say so. */
export function isDemoSource(source: Pick<FeedSource, "demo"> | null): boolean {
  return source?.demo === true;
}

function demoSource(): Promise<FeedSource> {
  return import("./mockSource").then((m) => Object.assign(m.createMockSource(), { demo: true }));
}

export function wantsMock(search: string): boolean {
  return new URLSearchParams(search).get("mock") === "1";
}

/** Picks the real API when it answers, otherwise the fixture-backed mock. ?mock=1 forces the mock. */
export async function createSource(search: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<FeedSource> {
  if (wantsMock(search)) return demoSource();
  const probe = await probeApi(fetchFn);
  return probe.ok ? createHttpSource(probe.alerts, fetchFn) : demoSource();
}
