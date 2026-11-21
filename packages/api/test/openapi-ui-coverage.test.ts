import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../src/openapi.js";

/**
 * SPEC acceptance criterion 11: no UI feature may use an API endpoint the
 * OpenAPI document leaves out. This test scans the web sources for `/api/...`
 * calls and checks each METHOD + path against the generated document.
 */

export interface UiCall {
  method: string;
  path: string;
  file: string;
  line: number;
}

const METHODS = "GET|POST|PUT|PATCH|DELETE";

/** Replaces comments with spaces (keeping offsets and newlines) so commented-out paths are ignored. */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|\s)\/\/[^\n]*/g,
      (m, p: string) => p + blank(m.slice(p.length)),
    );
}

interface Chain {
  text: string;
  end: number;
}

/**
 * Parses a string/template literal at `pos`, plus any `+ fn(...)` / `+ "..."` continuation
 * (e.g. `"/api/rules/" + encodeURIComponent(id) + "/export"`). `${...}` becomes `{param}`,
 * or the helper's path when it is a known helper call such as `${base(id)}`.
 */
function parseChain(
  src: string,
  pos: number,
  helpers: Map<string, string>,
): Chain | null {
  const lit = /^(?:"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`)/;
  const first = lit.exec(src.slice(pos));
  if (!first) return null;
  const render = (m: RegExpExecArray): string => {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    return raw.replace(/\$\{([^}]*)\}/g, (_x, expr: string) => {
      const h = /^\s*(\w+)\(/.exec(expr);
      return (h && helpers.get(h[1]!)) || "{param}";
    });
  };
  let text = render(first);
  let end = pos + first[0].length;
  for (;;) {
    const rest = src.slice(end);
    const call = /^\s*\+\s*[\w.]+\([^()]*\)/.exec(rest);
    if (call) {
      text += "{param}";
      end += call[0].length;
      continue;
    }
    const more = /^\s*\+\s*(?=["'`])/.exec(rest);
    const next = more && lit.exec(rest.slice(more[0].length));
    if (more && next) {
      text += render(next);
      end += more[0].length + next[0].length;
      continue;
    }
    return { text, end };
  }
}

/** Explicit method near a literal: `"POST", <url>` before it, or `method: "PUT"` inside the same call after it. */
function detectMethod(src: string, start: number, end: number): string {
  const before = new RegExp(`["'\`](${METHODS})["'\`]\\s*,\\s*$`).exec(
    src.slice(Math.max(0, start - 60), start),
  );
  if (before) return before[1]!;
  let depth = 0;
  for (let i = end; i < Math.min(src.length, end + 400); i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (--depth < 0) break;
    } else if (c === ";") break;
    else if (depth === 0 || c === "m") {
      const m = new RegExp(`^method\\s*:\\s*["'\`](${METHODS})["'\`]`).exec(
        src.slice(i, i + 40),
      );
      if (m && !/\w/.test(src[i - 1] ?? " ")) return m[1]!;
    }
  }
  return "GET";
}

/** Extracts every `/api/...` call (method + normalised path) from one source file. */
export function extractCalls(source: string, file: string): UiCall[] {
  const src = stripComments(source);
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;

  // Path helpers such as `const base = (id) => `/api/alerts/${...}``.
  const helpers = new Map<string, string>();
  const defs = new Set<number>();
  for (const m of src.matchAll(
    /const (\w+)\s*=\s*\([^)]*\)\s*=>\s*(?=["'`])/g,
  )) {
    const at = m.index! + m[0].length;
    const c = parseChain(src, at, helpers);
    if (c && c.text.startsWith("/api/")) {
      helpers.set(m[1]!, c.text);
      defs.add(at);
    }
  }

  const calls: UiCall[] = [];
  const push = (text: string, start: number, end: number) => {
    if (!text.startsWith("/api/")) return;
    const path = text.split(/[?#]/)[0]!;
    calls.push({
      method: detectMethod(src, start, end),
      path,
      file,
      line: lineOf(start),
    });
  };

  for (let i = 0; i < src.length; i++) {
    if (!`"'\``.includes(src[i]!)) continue;
    const c = parseChain(src, i, helpers);
    if (!c) continue;
    if (!defs.has(i)) push(c.text, i, c.end);
    i = c.end - 1;
  }
  // Bare helper uses, e.g. request("GET", base(id)); uses inside `${...}` are part of their literal.
  for (const [name, path] of helpers) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.$])${name}\\(`, "g"))) {
      const at = m.index!;
      if (src.slice(Math.max(0, at - 2), at) === "${") continue;
      if (
        /=\s*\([^)]*\)\s*=>\s*$/.test(src.slice(Math.max(0, at - 80), at)) ||
        /const\s+$/.test(src.slice(0, at))
      )
        continue;
      let depth = 0;
      let end = at;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")" && --depth === 0) break;
      }
      push(path, at, end + 1);
    }
  }
  return calls.sort((a, b) => a.line - b.line);
}

const norm = (p: string) => p.replace(/\{[^}/]*\}/g, "{}");
const label = (m: string, p: string) => `${m} ${p}`;

/** Returns a readable "METHOD /api/path  (file:line)" line for every call missing from the document. */
export function diffCalls(
  calls: UiCall[],
  docPaths: Record<string, Record<string, unknown>>,
): string[] {
  const known = new Set<string>();
  for (const [p, ops] of Object.entries(docPaths))
    for (const m of Object.keys(ops))
      known.add(label(m.toUpperCase(), norm(p)));
  const missing = new Map<string, string>();
  for (const c of calls) {
    const key = label(c.method, norm(c.path));
    if (!known.has(key) && !missing.has(key))
      missing.set(key, `${label(c.method, c.path)}  (${c.file}:${c.line})`);
  }
  return [...missing.values()];
}

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, "../../web/src");

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory())
      return e.name === "e2e" || e.name === "node_modules"
        ? []
        : listSources(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)
      ? [p]
      : [];
  });
}

describe("OpenAPI covers every API call made by the web UI", () => {
  it("extracts template-literal paths with params and methods", () => {
    const src = [
      "// fetch('/api/commented/out')",
      "const a = fetch(`/api/things/${encodeURIComponent(id)}/go?x=1`, { method: 'POST' });",
      'const b = send("PUT", "/api/rules/" + encodeURIComponent(id) + "/export");',
      'const c = fetch("/api/plain");',
      "const base = (id) => `/api/alerts/${id}`;",
      'const d = request("GET", base(id)); const e = request("POST", `${base(id)}/ack`);',
    ].join("\n");
    const got = extractCalls(src, "x.ts").map((c) => label(c.method, c.path));
    expect(got).toEqual([
      "POST /api/things/{param}/go",
      "PUT /api/rules/{param}/export",
      "GET /api/plain",
      "POST /api/alerts/{param}/ack",
      "GET /api/alerts/{param}",
    ]);
  });

  it("reports unknown endpoints with method, path and location", () => {
    const calls = extractCalls(
      '\n// x\nfetch(`/api/nope/${id}`, {method:"DELETE"});',
      "web/fake.ts",
    );
    expect(calls).toHaveLength(1);
    const doc = {
      "/api/nope/{id}": { get: {} },
      "/api/ok/{id}": { delete: {} },
    };
    expect(diffCalls(calls, doc)).toEqual([
      "DELETE /api/nope/{param}  (web/fake.ts:3)",
    ]);
    expect(diffCalls(calls, { "/api/nope/{other}": { delete: {} } })).toEqual(
      [],
    );
  });

  it("finds no UI call missing from the OpenAPI document", () => {
    const calls = listSources(webSrc).flatMap((f) =>
      extractCalls(
        readFileSync(f, "utf8"),
        relative(resolve(here, "../../.."), f),
      ),
    );
    // Guard against a broken extractor passing vacuously.
    expect(
      new Set(calls.map((c) => label(c.method, norm(c.path)))).size,
    ).toBeGreaterThanOrEqual(5);
    const doc = buildOpenApi() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const missing = diffCalls(calls, doc.paths);
    expect(
      missing,
      `UI calls missing from OpenAPI:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
