export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Return `{ items, nextBefore?, nextOffset? }` using the x-next-* response headers. */
  paging?: boolean;
}

export type ApiResult = { ok: true; text: string } | { ok: false; text: string };

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Message of an API error body (`{ error, position?, state? }`), falling back to the raw text. */
function errorMessage(status: number, raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && "error" in v && typeof v.error === "string") {
      let msg = `HTTP ${status}: ${v.error}`;
      if ("position" in v && typeof v.position === "number" && !/position|column|col\b/i.test(v.error))
        msg += ` (at position ${v.position})`;
      for (const [k, val] of Object.entries(v)) {
        if (k === "error" || k === "position" || val === undefined || val === null) continue;
        msg += `, ${k}: ${typeof val === "string" ? val : JSON.stringify(val)}`;
      }
      return msg;
    }
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}: ${raw || "request failed"}`;
}

export function createClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async call(req: ApiRequest): Promise<ApiResult> {
      const url = new URL(base + req.path);
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const hasBody = req.body !== undefined;
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: hasBody ? { "content-type": "application/json" } : undefined,
          body: hasBody ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, text: errorMessage(res.status, text) };
        if (req.paging) {
          const nextBefore = res.headers.get("x-next-before");
          const nextOffset = res.headers.get("x-next-offset");
          const out: Record<string, unknown> = { items: JSON.parse(text) as unknown };
          if (nextBefore) out.nextBefore = nextBefore;
          if (nextOffset) out.nextOffset = Number(nextOffset);
          return { ok: true, text: JSON.stringify(out) };
        }
        return { ok: true, text: text === "" ? "{}" : text };
      } catch (e) {
        return { ok: false, text: `Could not reach the API at ${base}: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
