export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export type ApiResult = { ok: true; text: string } | { ok: false; text: string };

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Message of an API error body (`{ error, position? }`), falling back to the raw text. */
function errorMessage(status: number, raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && "error" in v && typeof v.error === "string") {
      const pos = "position" in v && typeof v.position === "number" ? ` (at position ${v.position})` : "";
      return `HTTP ${status}: ${v.error}${pos}`;
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
        return { ok: true, text: text === "" ? "{}" : text };
      } catch (e) {
        return { ok: false, text: `Could not reach the API at ${base}: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
