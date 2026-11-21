/** Pure helpers that turn raw event JSON into brackets-free, readable rows. */

const ACRONYMS = new Set(["id", "ids", "url", "uri", "api", "ip", "uuid", "http", "https", "sla", "cpu", "utc", "sql", "ssl", "tls", "dns"]);

/** `workflowId` -> `Workflow ID`, `startsAt` -> `Starts at`, `error_code` -> `Error code`. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower === "ids" ? "IDs" : lower.toUpperCase();
      if (w === w.toUpperCase() && w.length > 1 && /[A-Z]/.test(w) && i > 0) return w;
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

const TIME_KEY = /(^|[^a-z])(time|timestamp|date|datetime)$|(time|timestamp|date)$|[a-z]At$|^(at|since|until|expires|startsAt|endsAt)$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export function looksLikeTimeKey(key: string): boolean {
  return TIME_KEY.test(key) || TIME_KEY.test(key.toLowerCase());
}

/** Returns a Date for ISO strings, or for epoch s/ms numbers when the key looks like a time. Else null. */
export function parseTimestamp(key: string, value: unknown): Date | null {
  if (typeof value === "string") {
    const m = DATE_ONLY_RE.exec(value);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d.getMonth() === Number(m[2]) - 1 ? d : null;
    }
    if (!ISO_RE.test(value)) return null;
    const d = new Date(value.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (typeof value === "number" && Number.isFinite(num) && looksLikeTimeKey(key)) {
    // 2001..2286 in seconds, or in milliseconds.
    if (num >= 1e9 && num < 1e11) return new Date(num * 1000);
    if (num >= 1e12 && num < 1e14) return new Date(num);
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** `23 Oct 2026, 09:14:02` in the viewer's local time zone. */
export function formatDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function relativeTime(d: Date, now: Date = new Date()): string {
  const diff = Math.round((now.getTime() - d.getTime()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 5) return "just now";
  let n: string;
  if (abs < 60) n = `${abs} sec`;
  else if (abs < 3600) n = `${Math.floor(abs / 60)} min`;
  else if (abs < 86400) n = `${Math.floor(abs / 3600)} h`;
  else n = `${Math.floor(abs / 86400)} d`;
  return diff >= 0 ? `${n} ago` : `in ${n}`;
}

/** `23 Oct 2026, 09:14:02 (2 min ago)` */
export function formatTimestamp(d: Date, now: Date = new Date()): string {
  return `${formatDate(d)} (${relativeTime(d, now)})`;
}

/** Display string for a timestamp-like value (ISO, date-only, epoch s/ms for time keys), or null. */
export function formatTimeValue(key: string, value: unknown, now: Date = new Date()): string | null {
  const d = parseTimestamp(key, value);
  if (!d) return null;
  if (typeof value === "string" && DATE_ONLY_RE.test(value)) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return formatTimestamp(d, now);
}

export interface Display {
  text: string;
  mono: boolean;
  muted: boolean;
}

const MONO_KEY = /(^|[a-z])(Id|Ids|Key|Uuid|Hash|Sha|Ref|Code|Type|Status)$|^(id|key|uuid|hash|sha|ref|code|type|status|dedupKey)$|_(id|key|code|uuid)$/;
const CODE_VALUE = /^[A-Z0-9][A-Z0-9_\-:.]{2,}$/;
const NO_SEPARATOR_WORDS = new Set(["id", "code", "year", "port", "zip", "phone", "version", "pid"]);
/** True when the last camelCase/snake word of the key is an identifier-like word (`workflowId`, not `valid`). */
function noSeparator(key: string): boolean {
  const last = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-.]+/).pop() ?? "";
  return NO_SEPARATOR_WORDS.has(last.toLowerCase());
}

export function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (isPlainObject(v) && Object.keys(v).length === 0)
  );
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Format a primitive value for display. */
export function formatPrimitive(key: string, value: unknown, now: Date = new Date()): Display {
  if (isEmptyValue(value)) return { text: "—", mono: false, muted: true };
  if (typeof value === "boolean") return { text: value ? "Yes" : "No", mono: false, muted: false };
  const when = formatTimeValue(key, value, now);
  if (when) return { text: when, mono: false, muted: false };
  if (typeof value === "number") {
    const plain = !Number.isFinite(value) || noSeparator(key) || Math.abs(value) < 1000;
    return { text: plain ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 20 }), mono: false, muted: false };
  }
  const s = String(value);
  return { text: s, mono: MONO_KEY.test(key) || CODE_VALUE.test(s), muted: false };
}

/** Format an array of primitives as a comma-separated line. */
export function formatList(key: string, items: unknown[], now: Date = new Date()): Display {
  const parts = items.map((i) => formatPrimitive(key, i, now).text);
  return { text: parts.join(", "), mono: items.every((i) => formatPrimitive(key, i, now).mono), muted: false };
}

export type TreeNode =
  | { kind: "field"; key: string; label: string; path: string; display: Display }
  | { kind: "section"; key: string; label: string; path: string; children: TreeNode[] };

function singular(label: string): string {
  if (/ies$/i.test(label)) return label.slice(0, -3) + "y";
  if (/(ss|us)$/i.test(label)) return label;
  if (/s$/i.test(label)) return label.slice(0, -1);
  return label;
}

function nodeFor(key: string, label: string, path: string, value: unknown, now: Date): TreeNode {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    return { kind: "section", key, label, path, children: objectNodes(value, path, now) };
  }
  if (Array.isArray(value) && value.length > 0) {
    if (value.every((i) => i === null || typeof i !== "object")) {
      return { kind: "field", key, label, path, display: formatList(key, value, now) };
    }
    const noun = singular(label);
    return {
      kind: "section",
      key,
      label,
      path,
      children: value.map((item, i) => nodeFor(key, `${noun} ${i + 1}`, `${path}[${i}]`, item, now)),
    };
  }
  return { kind: "field", key, label, path, display: formatPrimitive(key, value, now) };
}

/** Build the display tree for an object, keeping the original key order. */
export function objectNodes(obj: Record<string, unknown>, prefix = "", now: Date = new Date()): TreeNode[] {
  return Object.entries(obj).map(([k, v]) => nodeFor(k, humanize(k), prefix ? `${prefix}.${k}` : k, v, now));
}
