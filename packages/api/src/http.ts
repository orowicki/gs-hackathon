import type http from "node:http";

/**
 * Dependencies handed to every route. Only the fields every route needs live here;
 * each route file adds its own optional fields with
 *   declare module "../http.js" { interface Deps { myThing?: MyThing } }
 * so adding a route never edits this file.
 */
export interface Deps {
  checkPostgres(): Promise<boolean>;
  checkRedis(): Promise<boolean>;
}

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** Path without the query string. */
  path: string;
  url: URL;
  deps: Deps;
}

/**
 * One file in src/routes/ named `<name>.routes.ts` with `export default` of this.
 * `handle` returns true when it answered (or will answer) the request, false to let
 * the next route try. Throwing / rejecting answers 500.
 */
export interface RouteModule {
  name: string;
  /** Lower runs first; default 100. The static web app uses 1000 (catch-all). */
  order?: number;
  handle(ctx: RouteContext): boolean | Promise<boolean>;
}

export function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Decode a path segment; undefined when it is malformed. */
export function decodeSegment(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}
