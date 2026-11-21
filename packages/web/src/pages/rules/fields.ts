import { useEffect, useState } from "react";

/** Used until (or if) the API answers, so the editor always offers something. */
const FALLBACK = [
  "alert.title",
  "alert.source",
  "alert.environment",
  "alert.severity",
  "alert.status",
  "alert.schema",
  "failedStep",
  "workflowName",
  "errorMessage",
  "payload.desk",
  "payload.notional",
];

/** Every `path` and every `{{var}}` inside a schema's mapping, at any depth. */
function harvest(node: unknown, out: Set<string>): void {
  if (typeof node === "string") {
    for (const m of node.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) out.add(m[1]!);
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) harvest(x, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "path" && typeof v === "string") out.add(v);
      else harvest(v, out);
    }
  }
}

/**
 * Field names a rule can show or template: the common alert.* fields plus every raw
 * event field the schemas map from. Grows by itself as schemas are added.
 */
export function useFieldCatalog(): string[] {
  const [fields, setFields] = useState<string[]>(FALLBACK);
  useEffect(() => {
    let live = true;
    Promise.allSettled([
      fetch("/api/filters/suggest").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/schemas").then((r) => (r.ok ? r.json() : [])),
    ]).then(([common, schemas]) => {
      if (!live) return;
      const out = new Set<string>(FALLBACK);
      if (common.status === "fulfilled" && Array.isArray(common.value))
        for (const f of common.value) if (typeof f === "string" && /^[\w.]+$/.test(f) && f !== "NOT") out.add(f);
      if (schemas.status === "fulfilled" && Array.isArray(schemas.value))
        for (const s of schemas.value) harvest((s as { mapping?: unknown }).mapping, out);
      // alert.* first, then raw event fields, each alphabetical.
      const all = [...out];
      const common_ = all.filter((f) => f.startsWith("alert.")).sort();
      const raw = all.filter((f) => !f.startsWith("alert.")).sort();
      setFields([...common_, ...raw]);
    });
    return () => {
      live = false;
    };
  }, []);
  return fields;
}
