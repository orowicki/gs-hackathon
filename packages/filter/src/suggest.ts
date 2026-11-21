import { tokenize, type Token } from "./lexer.js";

export interface SuggestContext {
  expect: "field" | "operator" | "value" | "logic";
  /** For `value`: the field being compared. */
  field?: string;
  /** The partial token being typed at the cursor (may be empty). */
  prefix: string;
}

const OPS = new Set(["contains", "in", "matches"]);

/** Best-effort: which kind of token is expected at `cursor`. Never throws. */
export function suggestContext(text: string, cursor: number = text.length): SuggestContext {
  try {
    const at = Math.max(0, Math.min(cursor, text.length));
    let toks: Token[] = tokenize(text.slice(0, at));
    let prefix = "";
    const last = toks[toks.length - 1];
    if (last && last.end === at) {
      if (last.kind === "error") {
        // Unterminated quote: the user is typing a value.
        prefix = last.text;
        toks = toks.slice(0, -1);
        return { ...scan(toks, true), prefix };
      }
      if (last.kind === "word" || (last.kind === "sym" && /^[!<>=]+$/.test(last.raw)) || last.kind === "string") {
        prefix = last.kind === "string" ? last.text : last.raw;
        toks = toks.slice(0, -1);
      }
    }
    return { ...scan(toks, false), prefix };
  } catch {
    return { expect: "field", prefix: "" };
  }
}

function scan(toks: Token[], forceValue: boolean): Omit<SuggestContext, "prefix"> {
  let state: SuggestContext["expect"] = "field";
  let field: string | undefined;
  let inList = false;
  for (const t of toks) {
    const lower = t.raw.toLowerCase();
    const isSym = t.kind === "sym";
    if (state === "field") {
      if (isSym && t.raw === "(") continue;
      if (t.kind === "word" && lower === "not") continue;
      if (t.kind === "word") {
        field = t.raw;
        state = "operator";
      }
    } else if (state === "operator") {
      state = "value";
      if (t.kind === "word" && !OPS.has(lower)) state = "field";
    } else if (state === "value") {
      if (isSym && t.raw === "[") inList = true;
      else if (inList && isSym && t.raw === ",") continue;
      else if (inList && isSym && t.raw === "]") {
        inList = false;
        state = "logic";
      } else if (!inList) state = "logic";
    } else {
      if (t.kind === "word" && (lower === "and" || lower === "or")) state = "field";
      else if (isSym && t.raw === ")") state = "logic";
    }
  }
  if (forceValue) state = "value";
  return state === "value" ? { expect: state, field } : { expect: state };
}
