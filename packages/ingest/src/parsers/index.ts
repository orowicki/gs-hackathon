import type { JsonObject, ParserConfig } from "@alerting/shared";

/** A parser never throws; unreadable input yields `{ raw: "<text>" }`. */
export type Parser = (
  input: string | JsonObject,
  config: ParserConfig,
) => JsonObject;

export function toText(input: string | JsonObject): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

/** Strip trailing CR/LF characters from string input. */
export function stripEol(input: string): string {
  return input.replace(/[\r\n]+$/, "");
}

export function fallback(text: string): JsonObject {
  return { raw: text };
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const jsonParser: Parser = (input) => {
  if (typeof input !== "string") return input;
  const text = stripEol(input);
  try {
    const v: unknown = JSON.parse(text);
    return isPlainObject(v) ? v : fallback(text);
  } catch {
    return fallback(text);
  }
};

const LOGFMT_RE = /([^\s="]+)(?:=(?:"((?:[^"\\]|\\.)*)"|(\S*)))?/g;

export const logfmtParser: Parser = (input) => {
  const text = stripEol(toText(input));
  const out: JsonObject = {};
  let found = false;
  for (const m of text.matchAll(LOGFMT_RE)) {
    found = true;
    const key = m[1] as string;
    if (m[2] !== undefined)
      out[key] = m[2].replace(/\\(.)/g, (_, c: string) =>
        c === "n" ? "\n" : c === "t" ? "\t" : c,
      );
    else if (m[3] !== undefined) out[key] = m[3];
    else out[key] = true;
  }
  return found ? out : fallback(text);
};

export const regexParser: Parser = (input, config) => {
  const text = stripEol(toText(input));
  if (!config.pattern) return fallback(text);
  try {
    const m = new RegExp(config.pattern).exec(text);
    if (!m?.groups) return fallback(text);
    const out: JsonObject = {};
    let n = 0;
    for (const [k, v] of Object.entries(m.groups)) {
      if (v !== undefined) {
        out[k] = v;
        n++;
      }
    }
    return n > 0 ? out : fallback(text);
  } catch {
    return fallback(text);
  }
};

export const rawParser: Parser = (input) => fallback(stripEol(toText(input)));

export const PARSERS: Record<string, Parser> = {
  json: jsonParser,
  logfmt: logfmtParser,
  regex: regexParser,
  raw: rawParser,
};

export function registerParser(name: string, parser: Parser): void {
  PARSERS[name] = parser;
}

/** Dispatch on `config.type`; unknown types and throwing parsers fall back to `{ raw }`. */
export function parse(
  input: string | JsonObject,
  config: ParserConfig,
): JsonObject {
  const parser = PARSERS[config.type];
  try {
    return parser ? parser(input, config) : fallback(stripEol(toText(input)));
  } catch {
    return fallback(stripEol(toText(input)));
  }
}
