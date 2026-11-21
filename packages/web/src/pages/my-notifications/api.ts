import type { Person, Preference } from "../../../../shared/src/types/people";

async function fail(res: Response): Promise<never> {
  throw new Error(`${res.status} ${res.statusText || "request failed"}`.trim());
}

export async function listPeople(): Promise<Person[]> {
  const res = await fetch("/api/people");
  if (!res.ok) return fail(res);
  return (await res.json()) as Person[];
}

/** Returns undefined when the API has no preference (404). */
export async function getPreference(personId: string): Promise<Preference | undefined> {
  const res = await fetch(`/api/people/${encodeURIComponent(personId)}/preferences`);
  if (res.status === 404) return undefined;
  if (!res.ok) return fail(res);
  return (await res.json()) as Preference;
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
