import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Doc = Record<string, unknown>;
const load = (kind: string): Array<{ file: string; doc: Doc }> => {
  const dir = new URL(`../../../config/${kind}/`, import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => ({ file: `${kind}/${f}`, doc: parse(readFileSync(new URL(f, dir), "utf8")) as Doc }));
};

const people = load("people");
const groups = load("groups");
const runbooks = load("runbooks");
const rules = load("rules");
const personIds = new Set(people.map((p) => String(p.doc.id)));
const groupIds = new Set(groups.map((g) => String(g.doc.id)));

// `approvers` is a group id (see validateRunbook), so groups are the only valid target.
const runbookRefs = runbooks.map(({ file, doc }) => ({
  file,
  refs: ((doc.steps as Array<{ group?: string; approvers?: string }> | undefined) ?? []).flatMap((s) =>
    [s.group, s.approvers].filter((v): v is string => typeof v === "string"),
  ),
}));
const ruleRefs = rules.map(({ file, doc }) => ({
  file,
  refs: ((doc.who as Array<{ recipients?: Array<{ type: string; id: string }> }> | undefined) ?? []).flatMap((w) =>
    (w.recipients ?? []).filter((r) => r.type === "group").map((r) => r.id),
  ),
}));

describe("config references", () => {
  it.each(runbookRefs)("runbook $file only names groups that exist", ({ refs }) => {
    expect(refs.filter((g) => !groupIds.has(g))).toEqual([]);
  });
  it.each(ruleRefs)("rule $file only targets groups that exist", ({ refs }) => {
    expect(refs.filter((g) => !groupIds.has(g))).toEqual([]);
  });
  it.each(groups.map(({ file, doc }) => ({ file, members: (doc.memberIds as string[]) ?? [] })))(
    "group $file only has members that are people",
    ({ members }) => {
      expect(members.filter((m) => !personIds.has(m))).toEqual([]);
    },
  );
});
