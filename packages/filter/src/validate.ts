import { CMP_OPS, isValidField, type FilterNode, type FilterValue } from "./types.js";

const MAX_DEPTH = 100;

function fail(path: string, msg: string): never {
  throw new Error(`Invalid filter tree at ${path}: ${msg}`);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function value(v: unknown, path: string): FilterValue {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fail(path, "value must be a string or a finite number");
}

function node(x: unknown, path: string, depth: number): FilterNode {
  if (depth > MAX_DEPTH) fail(path, "tree is nested too deeply");
  if (!isObj(x)) return fail(path, "expected an object");
  switch (x.type) {
    case "and":
    case "or": {
      if (!Array.isArray(x.children) || x.children.length < 2) {
        return fail(path, `"${x.type}" needs a "children" array with at least 2 items`);
      }
      const children = x.children.map((c, i) => node(c, `${path}.children[${i}]`, depth + 1));
      return { type: x.type, children };
    }
    case "not":
      return { type: "not", child: node(x.child, `${path}.child`, depth + 1) };
    case "cmp": {
      if (!isValidField(x.field)) return fail(path, `"field" is not a valid field name`);
      if (typeof x.op !== "string" || !(CMP_OPS as readonly string[]).includes(x.op)) {
        return fail(path, `"op" must be one of ${CMP_OPS.join(", ")}`);
      }
      return { type: "cmp", field: x.field, op: x.op as (typeof CMP_OPS)[number], value: value(x.value, `${path}.value`) };
    }
    case "in": {
      if (!isValidField(x.field)) return fail(path, `"field" is not a valid field name`);
      if (!Array.isArray(x.values)) return fail(path, `"values" must be an array`);
      return { type: "in", field: x.field, values: x.values.map((v, i) => value(v, `${path}.values[${i}]`)) };
    }
    default:
      return fail(path, `"type" must be one of and, or, not, cmp, in`);
  }
}

/** Check an untrusted JSON tree (e.g. from the API) and return a clean copy. Throws Error with a clear message. */
export function validateTree(json: unknown): FilterNode {
  return node(json, "$", 0);
}
