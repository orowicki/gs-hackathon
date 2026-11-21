import type { Group, Person } from "../../../../shared/src/types/people";
import type { GroupDraft, PersonDraft } from "./model";

export class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T | undefined> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : undefined;
}

const list = async <T>(url: string): Promise<T[]> => {
  const r = await call<T[]>("GET", url);
  return Array.isArray(r) ? r : [];
};

export const listPeople = () => list<Person>("/api/people");
export const listGroups = () => list<Group>("/api/groups");
export const createPerson = (d: PersonDraft) => call<Person>("POST", "/api/people", d);
export const updatePerson = (id: string, d: PersonDraft) =>
  call<Person>("PUT", `/api/people/${encodeURIComponent(id)}`, { id, ...d });
export const deletePerson = (id: string) => call<void>("DELETE", `/api/people/${encodeURIComponent(id)}`);
export const createGroup = (d: GroupDraft) => call<Group>("POST", "/api/groups", d);
export const updateGroup = (id: string, d: GroupDraft) =>
  call<Group>("PUT", `/api/groups/${encodeURIComponent(id)}`, { id, ...d });
export const deleteGroup = (id: string) => call<void>("DELETE", `/api/groups/${encodeURIComponent(id)}`);
