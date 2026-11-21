import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json",
};

/**
 * Serve a file from `dir` for GET/HEAD. Paths without a file extension fall back to
 * index.html (SPA routes). Returns true if a response was sent.
 */
export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, dir: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    return false;
  }
  if (pathname.includes("\0")) return false;

  const root = path.resolve(dir);
  let file = path.resolve(root, "." + path.posix.normalize("/" + pathname));
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  if (!path.extname(file)) file = path.join(root, "index.html");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(file).pipe(res);
  }
  return true;
}
