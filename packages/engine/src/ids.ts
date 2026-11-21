import { createHash } from "node:crypto";

/** Deterministic UUID-shaped id from the given parts (sha256, version/variant bits set). */
export function deterministicId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** Remember that something was logged; true the first time a key is seen (bounded memory). */
const seen = new Set<string>();
export function firstTime(key: string): boolean {
  if (seen.has(key)) return false;
  if (seen.size > 10000) seen.clear();
  seen.add(key);
  return true;
}
