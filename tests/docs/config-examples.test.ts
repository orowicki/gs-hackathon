/**
 * Checks that every YAML example in docs/config-formats.md is a valid config entity.
 *
 * Marker convention: each ```yaml block must be preceded (previous non-blank line) by an HTML comment
 *   <!-- kind: rules -->                              kind = sources | schemas | rules | people | groups | runbooks | preferences
 *   <!-- kind: rules; file: config/rules/x.yaml -->   optional: the block must equal that file verbatim
 * A block without a marker, a missing/unknown kind, or zero blocks fails the test.
 *
 * Validation uses the real loader pieces (fromYaml, entityId, KIND_DIRS from @alerting/config) with
 * the same id fallback as the watcher, plus the stricter checks used elsewhere: filter parsing
 * (@alerting/filter), validateRunbook (@alerting/runbooks) and the shared enums.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KIND_DIRS, entityId, fromYaml, type Kind } from "@alerting/config";
import { parse as parseFilter, validateTree } from "@alerting/filter";
import { validateRunbook } from "@alerting/runbooks";
import { SCHEMA_COMMON_FIELD_NAMES } from "@alerting/schemas";
import { PARSER_TYPES, SEVERITIES, SOURCE_TYPES } from "@alerting/shared";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC = resolve(root, "docs/config-formats.md");

export interface Block {
  index: number;
  kind: string | undefined;
  file: string | undefined;
  line: number;
  text: string;
}

export function extractBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^```yaml\s*$/.test(lines[i])) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j--;
    const m = j >= 0 ? /^<!--\s*kind:\s*([\w-]+)\s*(?:;\s*file:\s*(\S+)\s*)?-->$/.exec(lines[j].trim()) : null;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
    blocks.push({ index: blocks.length, kind: m?.[1], file: m?.[2], line: i + 1, text: lines.slice(start, end).join("\n") + "\n" });
    i = end;
  }
  return blocks;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string" && x !== "";

function checkFilter(f: unknown, at: string): void {
  if (typeof f === "string") {
    try {
      parseFilter(f);
    } catch (e) {
      throw new Error(`${at}: bad filter ${JSON.stringify(f)}: ${(e as Error).message}`);
    }
  } else if (isObj(f)) {
    validateTree(f);
  } else throw new Error(`${at}: filter must be text or a tree`);
}

function checkMapping(m: unknown, at: string): void {
  if (!isObj(m)) throw new Error(`${at} must be an object`);
  if (!["path", "constant", "template"].includes(m.kind as string)) throw new Error(`${at}.kind must be path, constant or template`);
  const need = { path: "path", constant: "value", template: "template" }[m.kind as "path"];
  if (!str(m[need])) throw new Error(`${at}.${need} must be a non-empty string`);
}

const KINDS: Record<string, (e: Record<string, unknown>) => void> = {
  sources(e) {
    if (!str(e.name)) throw new Error("name required");
    if (typeof e.enabled !== "boolean") throw new Error("enabled must be a boolean");
    if (!(SOURCE_TYPES as readonly string[]).includes(e.type as string)) throw new Error(`type must be one of ${SOURCE_TYPES.join(", ")}`);
    if (!isObj(e.parser) || !(PARSER_TYPES as readonly string[]).includes(e.parser.type as string))
      throw new Error(`parser.type must be one of ${PARSER_TYPES.join(", ")}`);
    if (!isObj(e.config)) throw new Error("config must be an object");
    if (e.type === "file_tail" && !str(e.config.path)) throw new Error("config.path required");
    if (e.type === "redis_stream" && !(str(e.config.stream) && str(e.config.consumerGroup)))
      throw new Error("config.stream and config.consumerGroup required");
  },
  schemas(e) {
    if (!str(e.name)) throw new Error("name required");
    checkFilter(e.match, "match");
    if (!isObj(e.mapping)) throw new Error("mapping must be an object");
    const allowed = [...SCHEMA_COMMON_FIELD_NAMES, "status"] as string[];
    for (const [k, v] of Object.entries(e.mapping)) {
      if (!allowed.includes(k)) throw new Error(`unknown mapping field ${k}`);
      checkMapping(v, `mapping.${k}`);
    }
  },
  rules(e) {
    if (!str(e.name)) throw new Error("name required");
    if (typeof e.enabled !== "boolean") throw new Error("enabled must be a boolean");
    checkFilter(e.when, "when");
    if (!Array.isArray(e.who)) throw new Error("who must be a list");
    e.who.forEach((row: unknown, i: number) => {
      if (!isObj(row) || !Array.isArray(row.recipients) || row.recipients.length === 0) throw new Error(`who[${i}].recipients required`);
      for (const r of row.recipients as unknown[])
        if (!isObj(r) || !["person", "group"].includes(r.type as string) || !str(r.id)) throw new Error(`who[${i}] bad recipient`);
      if (row.condition !== undefined) checkFilter(row.condition, `who[${i}].condition`);
    });
    if (!isObj(e.looks) || !str(e.looks.titleTemplate) || !Array.isArray(e.looks.fields)) throw new Error("looks.titleTemplate and looks.fields required");
    if (e.looks.severityOverride !== undefined && !(SEVERITIES as readonly string[]).includes(e.looks.severityOverride as string))
      throw new Error("looks.severityOverride invalid");
    if (!str(e.createdAt) || !str(e.updatedAt)) throw new Error("createdAt and updatedAt must be strings (quote them)");
  },
  people(e) {
    if (!str(e.name) || !str(e.role)) throw new Error("name and role required");
    if (typeof e.canCreateRules !== "boolean") throw new Error("canCreateRules must be a boolean");
    if (e.ntfyTopic !== undefined && typeof e.ntfyTopic !== "string") throw new Error("ntfyTopic must be a string");
  },
  groups(e) {
    if (!str(e.name)) throw new Error("name required");
    if (!Array.isArray(e.memberIds) || !e.memberIds.every(str)) throw new Error("memberIds must be a list of ids");
  },
  runbooks(e) {
    const r = validateRunbook(e);
    if (!r.ok) throw new Error(r.error);
    checkFilter(e.matches, "matches");
  },
  preferences(e) {
    if (!Array.isArray(e.rules)) throw new Error('"rules" must be a list');
    e.rules.forEach((r: unknown, i: number) => {
      if (!isObj(r) || !Array.isArray(r.channels)) throw new Error(`rules[${i}] needs when and channels`);
      checkFilter(r.when, `rules[${i}].when`);
      // The API stores the PUT body as given and only accepts a tree for `when`.
      if (!isObj(r.when)) throw new Error(`rules[${i}].when must be a filter tree (the API rejects text)`);
    });
    if (e.quietHours !== undefined) {
      const q = e.quietHours;
      if (!isObj(q) || ![q.from, q.to].every((t) => typeof t === "string" && /^\d\d:\d\d$/.test(t)) || !str(q.timezone))
        throw new Error("quietHours needs from, to (HH:MM) and timezone");
    }
  },
};

const DIR_KIND = (dirKind: string): Kind => (dirKind === "preferences" ? "preference" : KIND_DIRS[dirKind]);

/** Validate one YAML text of the given doc kind; throws with the reason. */
export function validateConfigYaml(kind: string | undefined, text: string, fallbackId = "example"): void {
  const check = kind === undefined ? undefined : KINDS[kind];
  if (kind === undefined || !check) throw new Error(`unknown or missing kind ${String(kind)}`);
  const storeKind = DIR_KIND(kind);
  let value = fromYaml(text);
  if (storeKind !== "preference" && isObj(value) && value.id === undefined) value = { ...value, id: fallbackId };
  entityId(storeKind, value); // loader check: object with usable id
  check(value as Record<string, unknown>);
}

describe("docs/config-formats.md examples", () => {
  const blocks = extractBlocks(readFileSync(DOC, "utf8"));

  it("has yaml blocks, each with a kind marker", () => {
    expect(blocks.length).toBeGreaterThan(0);
    const missing = blocks.filter((b) => !b.kind).map((b) => `block ${b.index} (line ${b.line})`);
    expect(missing, "blocks without <!-- kind: ... --> marker").toEqual([]);
  });

  it("covers every config kind", () => {
    const kinds = new Set(blocks.map((b) => b.kind));
    for (const k of Object.keys(KINDS)) expect(kinds.has(k), `no example for ${k}`).toBe(true);
  });

  for (const b of blocks) {
    it(`block ${b.index} (${b.kind ?? "no kind"}, line ${b.line}) is valid`, () => {
      try {
        validateConfigYaml(b.kind, b.text);
      } catch (e) {
        throw new Error(`yaml block ${b.index} at ${DOC}:${b.line}: ${(e as Error).message}`);
      }
    });
    if (b.file) {
      it(`block ${b.index} equals ${b.file}`, () => {
        expect(b.text).toBe(readFileSync(resolve(root, b.file!), "utf8"));
      });
    }
  }
});

describe("validateConfigYaml", () => {
  const goodGroup = "id: g\nname: G\nmemberIds: [a]\n";
  it("accepts a valid snippet and falls back to a default id", () => {
    expect(() => validateConfigYaml("groups", goodGroup)).not.toThrow();
    expect(() => validateConfigYaml("groups", "name: G\nmemberIds: []\n")).not.toThrow();
  });
  it("rejects invalid snippets", () => {
    expect(() => validateConfigYaml("groups", "id: g\nname: G\nmemberIds: nope\n")).toThrow(/memberIds/);
    expect(() => validateConfigYaml("groups", "id: [unclosed\n")).toThrow(/YAML/);
    expect(() => validateConfigYaml("rules", "id: r\nname: R\nenabled: true\nwhen: 'alert.severity ='\nwho: []\nlooks: { titleTemplate: t, fields: [] }\ncreatedAt: x\nupdatedAt: x\n")).toThrow(/bad filter/);
    expect(() => validateConfigYaml("runbooks", "id: r\nname: R\ntype: wait\n")).toThrow(/type/);
    expect(() => validateConfigYaml("nonsense", goodGroup)).toThrow(/unknown or missing kind/);
    expect(() => validateConfigYaml(undefined, goodGroup)).toThrow(/missing kind/);
  });
  it("extracts blocks and flags missing markers", () => {
    const md = "<!-- kind: groups -->\n```yaml\nid: a\n```\n\n```yaml\nid: b\n```\n";
    const bs = extractBlocks(md);
    expect(bs.map((b) => b.kind)).toEqual(["groups", undefined]);
    expect(extractBlocks("no blocks")).toEqual([]);
  });
});
