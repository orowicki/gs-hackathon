import type { ChannelStatus } from "../../../../shared/src/types/notification";
import type { Person, Preference } from "../../../../shared/src/types/people";

async function fail(res: Response): Promise<never> {
  throw new Error(`${res.status} ${res.statusText || "request failed"}`.trim());
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

export const listPeople = () => getJson<Person[]>("/api/people");
/** Every registered delivery channel with its health; drives the columns of the grid. */
export const listChannels = () => getJson<ChannelStatus[]>("/api/channels");

/** Returns undefined when the API has no preference (404) or an empty/malformed one. */
export async function getPreference(personId: string): Promise<Preference | undefined> {
  const res = await fetch(`/api/people/${encodeURIComponent(personId)}/preferences`);
  if (res.status === 404) return undefined;
  if (!res.ok) return fail(res);
  const pref = (await res.json().catch(() => undefined)) as Preference | undefined;
  if (!pref || !Array.isArray(pref.rules) || pref.rules.length === 0) return undefined;
  return pref;
}

export async function putPreference(personId: string, pref: Preference): Promise<Preference> {
  const res = await fetch(`/api/people/${encodeURIComponent(personId)}/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pref),
  });
  if (!res.ok) return fail(res);
  return (await res.json().catch(() => pref)) as Preference;
}
