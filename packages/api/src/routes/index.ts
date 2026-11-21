import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RouteModule } from "../http.js";

// Loads every `*.routes.ts` (source, under vitest) or `*.routes.js` (built) file in this
// folder. To add routes, add a file; nothing here or in server.ts changes.
const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => /\.routes\.(js|ts)$/.test(f) && !f.endsWith(".d.ts"));

const loaded = await Promise.all(
  files.map(async (f) => {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default?: RouteModule };
    if (!mod.default || typeof mod.default.handle !== "function")
      throw new Error(`routes/${f}: missing default export { name, handle }`);
    return mod.default;
  }),
);

export const routeModules: readonly RouteModule[] = loaded.sort(
  (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name),
);
