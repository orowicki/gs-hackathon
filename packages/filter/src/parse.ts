import { tokenize, type Token } from "./lexer.js";
import { CMP_OPS, isValidField, NUMBER_RE, type CmpOp, type FilterNode, type FilterValue } from "./types.js";

export class FilterSyntaxError extends Error {
  /** 1-based character column. */
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "FilterSyntaxError";
    this.position = position;
  }
}

export type ParseResult =
  | { ok: true; tree: FilterNode | null }
  | { ok: false; error: { message: string; position: number } };

const WORD_OPS = new Set(["contains", "in", "matches"]);
const MAX_DEPTH = 100;

class Parser {
  private i = 0;
  private depth = 0;
  constructor(
    private readonly toks: Token[],
    private readonly len: number,
  ) {}

  private peek(): Token | undefined {
    const t = this.toks[this.i];
    if (t?.kind === "error") throw new FilterSyntaxError(t.message ?? "Invalid text", t.start + 1);
    return t;
  }
  private next(): Token {
    const t = this.peek();
    if (!t) throw new FilterSyntaxError("Unexpected end of filter", this.len + 1);
    this.i++;
    return t;
  }
  private pos(t: Token | undefined): number {
    return (t ? t.start : this.len) + 1;
  }
  private isKw(t: Token | undefined, kw: string): boolean {
    return t?.kind === "word" && t.raw.toLowerCase() === kw;
  }
  private isSym(t: Token | undefined, s: string): boolean {
    return t?.kind === "sym" && t.raw === s;
  }

  parseTop(): FilterNode {
    const node = this.parseOr();
    const t = this.peek();
    if (t) {
      if (this.isSym(t, ")")) throw new FilterSyntaxError(`Unexpected ")" at position ${this.pos(t)}`, this.pos(t));
      throw new FilterSyntaxError(
        `Unexpected ${JSON.stringify(t.raw)} at position ${this.pos(t)}. Expected AND, OR or the end of the filter`,
        this.pos(t),
      );
    }
    return node;
  }

  private parseOr(): FilterNode {
    const kids = [this.parseAnd()];
    while (this.isKw(this.peek(), "or")) {
      this.i++;
      kids.push(this.parseAnd());
    }
    return kids.length === 1 ? kids[0] : { type: "or", children: kids };
  }

  private parseAnd(): FilterNode {
    const kids = [this.parseUnary()];
    while (this.isKw(this.peek(), "and")) {
      this.i++;
      kids.push(this.parseUnary());
    }
    return kids.length === 1 ? kids[0] : { type: "and", children: kids };
  }

  private parseUnary(): FilterNode {
    const t = this.peek();
    if (this.isKw(t, "not")) {
      this.i++;
      return this.nested(() => ({ type: "not", child: this.parseUnary() }));
    }
    if (this.isSym(t, "(")) {
      this.i++;
      const inner = this.nested(() => this.parseOr());
      const c = this.peek();
      if (!this.isSym(c, ")")) {
        if (!c) {
          throw new FilterSyntaxError(
            `Missing ")" to close the "(" at position ${this.pos(t)}`,
            this.pos(t),
          );
        }
        throw new FilterSyntaxError(
          `Unexpected ${JSON.stringify(c.raw)} at position ${this.pos(c)}. Expected AND, OR or ")"`,
          this.pos(c),
        );
      }
      this.i++;
      return inner;
    }
    if (this.isSym(t, ")")) throw new FilterSyntaxError(`Unexpected ")" at position ${this.pos(t)}`, this.pos(t));
    return this.parseCondition();
  }

  private nested<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) {
      throw new FilterSyntaxError("Filter is nested too deeply", this.pos(this.toks[this.i]));
    }
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private parseCondition(): FilterNode {
    const ft = this.peek();
    if (!ft || ft.kind !== "word" || !isValidField(ft.raw)) {
      throw new FilterSyntaxError(`Expected a field name at position ${this.pos(ft)}`, this.pos(ft));
    }
    this.i++;
    const field = ft.raw;
    const ot = this.peek();
    if (!ot) {
      throw new FilterSyntaxError(`Expected an operator after "${field}" at position ${this.pos(ot)}`, this.pos(ot));
    }
    const word = ot.kind === "word" ? ot.raw.toLowerCase() : undefined;
    const sym = ot.kind === "sym" ? ot.raw : undefined;
    const op = word && WORD_OPS.has(word) ? word : sym;
    if (!op || !(op === "in" || (CMP_OPS as readonly string[]).includes(op))) {
      throw new FilterSyntaxError(
        `Unknown operator ${JSON.stringify(ot.raw)} at position ${this.pos(ot)}. Expected =, !=, >, >=, <, <=, contains, in or matches`,
        this.pos(ot),
      );
    }
    this.i++;
    if (op === "in") return { type: "in", field, values: this.parseList() };
    const value = this.parseValue(`after "${op}"`);
    return { type: "cmp", field, op: op as CmpOp, value };
  }

  private parseValue(context: string): FilterValue {
    const t = this.peek();
    const ok = t && (t.kind === "string" || t.kind === "word");
    if (!ok) throw new FilterSyntaxError(`Expected a value ${context} at position ${this.pos(t)}`, this.pos(t));
    this.i++;
    if (t.kind === "word" && NUMBER_RE.test(t.raw)) {
      const n = Number(t.raw);
      if (!Number.isFinite(n)) {
        throw new FilterSyntaxError(`Number is too large at position ${this.pos(t)}`, this.pos(t));
      }
      return n;
    }
    return t.text;
  }

  private parseList(): FilterValue[] {
    const open = this.peek();
    if (!this.isSym(open, "[")) {
      throw new FilterSyntaxError(
        `Expected a list like [a, b] after "in" at position ${this.pos(open)}`,
        this.pos(open),
      );
    }
    this.i++;
    const values: FilterValue[] = [];
    if (this.isSym(this.peek(), "]")) {
      this.i++;
      return values;
    }
    values.push(this.parseValue('after "["'));
    for (;;) {
      const t = this.peek();
      if (this.isSym(t, ",")) {
        this.i++;
        values.push(this.parseValue('after ","'));
      } else if (this.isSym(t, "]")) {
        this.i++;
        return values;
      } else {
        throw new FilterSyntaxError(
          `Missing "]" to close the list opened at position ${this.pos(open)}`,
          this.pos(open),
        );
      }
    }
  }
}

/** Parse filter text. Empty or whitespace-only text returns `null` (match everything). Throws FilterSyntaxError. */
export function parse(text: string): FilterNode | null {
  const toks = tokenize(text);
  if (toks.length === 0) return null;
  return new Parser(toks, text.length).parseTop();
}

export function tryParse(text: string): ParseResult {
  try {
    return { ok: true, tree: parse(text) };
  } catch (e) {
    if (e instanceof FilterSyntaxError) return { ok: false, error: { message: e.message, position: e.position } };
    throw e;
  }
}
