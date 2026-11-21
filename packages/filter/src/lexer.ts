export interface Token {
  kind: "word" | "string" | "sym" | "error";
  /** Raw source text of the token. */
  raw: string;
  /** Decoded value (strings: unescaped content; others: same as raw). */
  text: string;
  /** 0-based start offset. */
  start: number;
  /** 0-based exclusive end offset. */
  end: number;
  /** Only on error tokens. */
  message?: string;
}

const WORD_STOP = new Set([" ", "\t", "\n", "\r", "(", ")", "[", "]", ",", '"', "=", "!", "<", ">"]);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\" && (src[j + 1] === '"' || src[j + 1] === "\\")) {
          text += src[j + 1];
          j += 2;
        } else if (d === '"') {
          closed = true;
          j++;
          break;
        } else {
          text += d;
          j++;
        }
      }
      if (!closed) {
        out.push({
          kind: "error",
          raw: src.slice(i),
          text: src.slice(i + 1),
          start: i,
          end: src.length,
          message: `Missing closing quote for the text starting at position ${i + 1}`,
        });
        return out;
      }
      out.push({ kind: "string", raw: src.slice(i, j), text, start: i, end: j });
      i = j;
    } else if (c === ">" || c === "<" || c === "!" || c === "=") {
      const two = src[i + 1] === "=" && c !== "=";
      const raw = two ? c + "=" : c;
      out.push({ kind: "sym", raw, text: raw, start: i, end: i + raw.length });
      i += raw.length;
    } else if ("()[],".includes(c)) {
      out.push({ kind: "sym", raw: c, text: c, start: i, end: i + 1 });
      i++;
    } else {
      let j = i;
      while (j < src.length && !WORD_STOP.has(src[j])) j++;
      const raw = src.slice(i, j);
      out.push({ kind: "word", raw, text: raw, start: i, end: j });
      i = j;
    }
  }
  return out;
}
