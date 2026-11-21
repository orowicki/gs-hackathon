/** Small generic fetch helpers. Errors carry the server's `{ error }` message. */

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = undefined;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { headers: { accept: "application/json" } }));
}

export async function sendJson<T>(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function sendText<T>(method: "POST" | "PUT", url: string, text: string, contentType: string): Promise<T> {
  return parse<T>(await fetch(url, { method, headers: { "content-type": contentType }, body: text }));
}

export async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    try {
      const j = JSON.parse(text) as { error?: string };
      throw new Error(j.error ?? `Request failed (${res.status})`);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(`Request failed (${res.status})`);
      throw e;
    }
  }
  return text;
}
