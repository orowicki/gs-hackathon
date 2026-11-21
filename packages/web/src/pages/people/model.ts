import type { Group, Person } from "../../../../shared/src/types/people";

export type PersonDraft = Omit<Person, "id">;
export type GroupDraft = Omit<Group, "id">;

export type Errors = Partial<Record<string, string>>;

export const emptyPerson = (): PersonDraft => ({ name: "", role: "", canCreateRules: false, ntfyTopic: "" });
export const emptyGroup = (): GroupDraft => ({ name: "", memberIds: [] });

export function validatePerson(d: PersonDraft): Errors {
  const e: Errors = {};
  if (!d.name.trim()) e.name = "Name is required";
  if (!d.role.trim()) e.role = "Role is required";
  const t = d.ntfyTopic?.trim() ?? "";
  if (t && !/^[A-Za-z0-9_-]{1,64}$/.test(t)) e.ntfyTopic = "Topic may only contain letters, digits, - and _";
  return e;
}

export function validateGroup(d: GroupDraft): Errors {
  return d.name.trim() ? {} : { name: "Name is required" };
}

export function personPayload(d: PersonDraft): PersonDraft {
  const p: PersonDraft = { name: d.name.trim(), role: d.role.trim(), canCreateRules: d.canCreateRules };
  const t = d.ntfyTopic?.trim();
  if (t) p.ntfyTopic = t;
  return p;
}

export function groupPayload(d: GroupDraft): GroupDraft {
  return { name: d.name.trim(), memberIds: [...new Set(d.memberIds)] };
}

export function toggleMember(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
