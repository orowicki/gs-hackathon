import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../src/openapi.js";

/**
 * SPEC acceptance criterion 11: no UI feature may use an API endpoint the
 * OpenAPI document leaves out. This test parses the web sources with the
 * TypeScript compiler API, finds every call that sends a request to `/api/...`
 * (fetch, EventSource and the web app's own request wrappers) and checks each
 * METHOD + path against the generated document.
 */

export interface UiCall {
  method: string; // GET, POST, ... or UNKNOWN when it cannot be determined statically
  path: string;
  file: string;
  line: number;
}

export interface Extraction {
  calls: UiCall[];
  /** "file:line  reason" for request sites / /api/ literals the extractor could not tie to a call. */
  unresolved: string[];
}

export interface SourceFile {
  file: string;
  source: string;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

interface Wrapper {
  urlIndex: number;
  methodIndex?: number;
}

type FnNode = ts.FunctionLikeDeclaration;

const isFn = (n: ts.Node): n is FnNode =>
  ts.isFunctionDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isMethodDeclaration(n);

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression;
  return e;
}

interface FileInfo {
  sf: ts.SourceFile;
  file: string;
  consts: Map<string, ts.Expression>;
  helpers: Map<string, ts.Expression>; // `const base = (id) => `/api/...``
  consumed: Set<ts.Node>;
  wrappers: Map<string, Wrapper>;
}

function parse(f: SourceFile): FileInfo {
  const sf = ts.createSourceFile(
    f.file,
    f.source,
    ts.ScriptTarget.Latest,
    true,
    f.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const info: FileInfo = {
    sf,
    file: f.file,
    consts: new Map(),
    helpers: new Map(),
    consumed: new Set(),
    wrappers: new Map(),
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer
    ) {
      const init = unwrap(n.initializer);
      if (ts.isArrowFunction(init) && !ts.isBlock(init.body))
        info.helpers.set(n.name.text, unwrap(init.body));
      else if (!isFn(init)) info.consts.set(n.name.text, init);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return info;
}

/** Resolves an expression to a path string: `${...}` / `+ fn(...)` parts become {param}. undefined when fully dynamic. */
function resolveString(
  e: ts.Expression,
  info: FileInfo,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined;
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    info.consumed.add(e);
    return e.text;
  }
  if (ts.isTemplateExpression(e)) {
    info.consumed.add(e);
    return (
      e.head.text +
      e.templateSpans
        .map(
          (s) =>
            (resolveString(s.expression, info, depth + 1) ?? "{param}") +
            s.literal.text,
        )
        .join("")
    );
  }
  if (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = resolveString(e.left, info, depth + 1);
    const r = resolveString(e.right, info, depth + 1);
    return l === undefined && r === undefined
      ? undefined
      : (l ?? "{param}") + (r ?? "{param}");
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const h = info.helpers.get(e.expression.text);
    return h ? resolveString(h, info, depth + 1) : undefined;
  }
  if (ts.isIdentifier(e)) {
    const c = info.consts.get(e.text);
    return c ? resolveString(c, info, depth + 1) : undefined;
  }
  return undefined;
}

function enclosingParam(
  node: ts.Node,
  name: string,
): { fn: FnNode; index: number; param: ts.ParameterDeclaration } | undefined {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (!isFn(p)) continue;
    const index = p.parameters.findIndex(
      (x) => ts.isIdentifier(x.name) && x.name.text === name,
    );
    if (index >= 0) return { fn: p, index, param: p.parameters[index]! };
  }
  return undefined;
}

function fnName(fn: FnNode): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  const p = fn.parent;
  return ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)
    ? p.name.text
    : undefined;
}

interface Site {
  info: FileInfo;
  node: ts.CallExpression | ts.NewExpression;
  callee: string;
  kind: "fetch" | "eventsource" | "wrapper";
  args: readonly ts.Expression[];
}

const lineOf = (info: FileInfo, n: ts.Node) =>
  info.sf.getLineAndCharacterOfPosition(n.getStart(info.sf)).line + 1;

/** Extracts every `/api/...` request (method + path) from the given sources. */
export function extractCalls(files: SourceFile[]): Extraction {
  const infos = files.map(parse);
  const sites: Site[] = [];
  const collect = (info: FileInfo) => {
    const visit = (n: ts.Node): void => {
      if (
        (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
        ts.isIdentifier(n.expression)
      ) {
        const callee = n.expression.text;
        const args = n.arguments ?? [];
        if (ts.isNewExpression(n) && callee === "EventSource")
          sites.push({ info, node: n, callee, kind: "eventsource", args });
        else if (ts.isCallExpression(n)) {
          const alias = enclosingParam(n, callee);
          const fetchLike =
            callee === "fetch" ||
            (alias && alias.param.type?.getText(info.sf) === "typeof fetch");
          sites.push({
            info,
            node: n,
            callee,
            kind: fetchLike ? "fetch" : "wrapper",
            args,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(info.sf);
  };
  infos.forEach(collect);

  // Wrapper discovery to a fixed point: a function that passes one of its own parameters as the URL
  // to fetch / EventSource / another wrapper is itself a wrapper (its callers are the real call sites).
  const global = new Map<string, Wrapper>();
  const wrapperOf = (s: Site): Wrapper | undefined =>
    s.kind === "fetch" || s.kind === "eventsource"
      ? { urlIndex: 0 }
      : (s.info.wrappers.get(s.callee) ?? global.get(s.callee));
  const delegating = new Set<Site>();
  for (let changed = true; changed;) {
    changed = false;
    for (const s of sites) {
      const w = wrapperOf(s);
      const arg = w && s.args[w.urlIndex];
      if (!w || !arg) continue;
      if (ts.isSpreadElement(arg)) {
        delegating.add(s);
        continue;
      }
      const u = unwrap(arg);
      const ep = ts.isIdentifier(u)
        ? enclosingParam(s.node, u.text)
        : undefined;
      if (!ep) continue;
      delegating.add(s);
      const name = fnName(ep.fn);
      if (!name || s.info.wrappers.has(name)) continue;
      const methodIndex = ep.fn.parameters.findIndex(
        (p) => ts.isIdentifier(p.name) && p.name.text === "method",
      );
      const def: Wrapper = {
        urlIndex: ep.index,
        ...(methodIndex >= 0 ? { methodIndex } : {}),
      };
      s.info.wrappers.set(name, def);
      if (!global.has(name)) global.set(name, def);
      changed = true;
    }
  }

  const calls: UiCall[] = [];
  const unresolved: string[] = [];
  for (const s of sites) {
    const w = wrapperOf(s);
    if (!w || delegating.has(s)) continue;
    const urlArg = s.args[w.urlIndex];
    const text = urlArg ? resolveString(urlArg, s.info) : undefined;
    if (
      s.kind === "wrapper" &&
      (text === undefined || !text.startsWith("/api/")) &&
      !s.info.wrappers.has(s.callee) &&
      !global.has(s.callee)
    )
      continue;
    const at = `${s.info.file}:${lineOf(s.info, s.node)}`;
    if (text === undefined || !text.startsWith("/api/")) {
      unresolved.push(
        `${at}  call site whose URL couldn't be resolved (${s.callee})`,
      );
      continue;
    }
    calls.push({
      method: methodOf(s, w),
      path: text.split(/[?#]/)[0]!,
      file: s.info.file,
      line: lineOf(s.info, s.node),
    });
  }

  // Any other /api/ string in the sources that no request site consumed (e.g. an <a href>) is reported too.
  for (const info of infos) {
    const visit = (n: ts.Node): void => {
      if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateExpression(n)
      ) {
        if (
          !info.consumed.has(n) &&
          !hasConsumedAncestor(n, info) &&
          (resolveString(n, info) ?? "").startsWith("/api/")
        ) {
          info.consumed.delete(n);
          unresolved.push(
            `${info.file}:${lineOf(info, n)}  /api/ path not used by any recognised request call`,
          );
        }
        if (ts.isTemplateExpression(n)) return;
      }
      ts.forEachChild(n, visit);
    };
    visit(info.sf);
  }
  return {
    calls: calls.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    ),
    unresolved,
  };
}

function hasConsumedAncestor(n: ts.Node, info: FileInfo): boolean {
  for (let p = n.parent; p; p = p.parent) if (info.consumed.has(p)) return true;
  return false;
}

/** Method of a request site; UNKNOWN when a method may be carried but is not a string literal. */
function methodOf(s: Site, w: Wrapper): string {
  if (s.kind === "eventsource") return "GET";
  const lit = (e: ts.Expression | undefined): string | undefined => {
    const u = e && unwrap(e);
    return u &&
      (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) &&
      METHODS.has(u.text.toUpperCase())
      ? u.text.toUpperCase()
      : undefined;
  };
  if (w.methodIndex !== undefined) {
    const arg = s.args[w.methodIndex];
    return arg ? (lit(arg) ?? "UNKNOWN") : "GET";
  }
  const opts = s.args.slice(w.urlIndex + 1);
  for (const [i, raw] of opts.entries()) {
    const a = unwrap(raw);
    if (!ts.isObjectLiteralExpression(a)) {
      if (s.kind === "fetch" && i === 0) return "UNKNOWN"; // options passed as a variable
      continue;
    }
    for (const p of a.properties) {
      if (ts.isSpreadAssignment(p)) return "UNKNOWN";
      if (p.name && ts.isIdentifier(p.name) && p.name.text === "method") {
        return ts.isPropertyAssignment(p)
          ? (lit(p.initializer) ?? "UNKNOWN")
          : "UNKNOWN";
      }
    }
  }
  return "GET";
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
    if (known.has(key) || missing.has(key)) continue;
    const why =
      c.method === "UNKNOWN" ? "  [HTTP method could not be determined]" : "";
    missing.set(key, `${label(c.method, c.path)}  (${c.file}:${c.line})${why}`);
  }
  return [...missing.values()];
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const webSrc = resolve(repoRoot, "packages/web/src");

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

const fx = (source: string, file = "web/fake.ts") =>
  extractCalls([{ file, source }]);
const labels = (x: Extraction) => x.calls.map((c) => label(c.method, c.path));

describe("OpenAPI covers every API call made by the web UI", () => {
  it("extracts template-literal paths with params, helpers and methods", () => {
    const x = fx(
      [
        "// fetch('/api/commented/out')",
        "const note = '/* not a comment'; const a = fetch(`/api/things/${encodeURIComponent(id)}/go?x=1`, { method: 'POST' });",
        'const b = send("PUT", "/api/rules/" + encodeURIComponent(id) + "/export");',
        'const c = fetch("/api/plain");',
        "const base = (id) => `/api/alerts/${id}`;",
        'const d = request("GET", base(id)); const e = request("POST", `${base(id)}/ack`);',
        "async function send(method: string, url: string) { return fetch(url, { method }); }",
        "async function request(method: string, url: string) { return fetch(url, { method }); }",
      ].join("\n"),
    );
    expect(x.unresolved).toEqual([]);
    expect(labels(x)).toEqual([
      "POST /api/things/{param}/go",
      "PUT /api/rules/{param}/export",
      "GET /api/plain",
      "GET /api/alerts/{param}",
      "POST /api/alerts/{param}/ack",
    ]);
  });

  it("reports unknown endpoints with method, path and location", () => {
    const { calls } = fx(
      '\n// x\nfetch(`/api/nope/${id}`, {method:"DELETE"});',
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

  it("does not silently turn an undeterminable method into GET", () => {
    const x = fx(
      [
        "const m = pick();",
        "fetch('/api/a', { method: m });", // computed method
        "fetch('/api/b', { ...init });", // spread options
        "fetch('/api/c', init);", // options in a variable
        "fetch('/api/d', { headers: {} });", // options without method: GET
        "new EventSource('/api/e');",
        "fetch('/api/f');",
      ].join("\n"),
    );
    expect(x.calls.map((c) => label(c.method, c.path))).toEqual([
      "UNKNOWN /api/a",
      "UNKNOWN /api/b",
      "UNKNOWN /api/c",
      "GET /api/d",
      "GET /api/e",
      "GET /api/f",
    ]);
    const doc = {
      "/api/a": { get: {} },
      "/api/b": { get: {} },
      "/api/c": { get: {} },
      "/api/d": { get: {} },
      "/api/e": { get: {} },
      "/api/f": { get: {} },
    };
    expect(diffCalls(x.calls, doc)).toEqual([
      "UNKNOWN /api/a  (web/fake.ts:2)  [HTTP method could not be determined]",
      "UNKNOWN /api/b  (web/fake.ts:3)  [HTTP method could not be determined]",
      "UNKNOWN /api/c  (web/fake.ts:4)  [HTTP method could not be determined]",
    ]);
  });

  it("flags a wrapper called with a non-literal method", () => {
    const x = fx(
      "async function call(method: string, url: string) { return fetch(url, { method }); }\ncall(verb, '/api/x');",
    );
    expect(labels(x)).toEqual(["UNKNOWN /api/x"]);
  });

  it("flags request sites whose URL cannot be resolved, and stray /api/ strings", () => {
    const x = fx(
      [
        "async function call(method: string, url: string) { return fetch(url, { method }); }",
        "fetch(buildUrl(id));",
        "new EventSource(dynamic);",
        "call('GET', somewhere());",
        "const link = '/api/stray';",
      ].join("\n"),
    );
    expect(x.calls).toEqual([]);
    expect(x.unresolved).toEqual([
      "web/fake.ts:2  call site whose URL couldn't be resolved (fetch)",
      "web/fake.ts:3  call site whose URL couldn't be resolved (EventSource)",
      "web/fake.ts:4  call site whose URL couldn't be resolved (call)",
      "web/fake.ts:5  /api/ path not used by any recognised request call",
    ]);
  });

  it("finds no UI call missing from the OpenAPI document", () => {
    const files = listSources(webSrc).map((f) => ({
      file: relative(repoRoot, f),
      source: readFileSync(f, "utf8"),
    }));
    const { calls, unresolved } = extractCalls(files);
    expect(
      unresolved,
      `Request sites the extractor could not resolve:\n${unresolved.join("\n")}`,
    ).toEqual([]);

    // Guard against a broken extractor passing vacuously.
    const distinct = new Set(calls.map((c) => label(c.method, norm(c.path))));
    expect(distinct.size).toBeGreaterThanOrEqual(40);
    for (const m of ["POST", "PUT", "DELETE"])
      expect(
        calls.some((c) => c.method === m),
        `no ${m} call extracted`,
      ).toBe(true);

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
