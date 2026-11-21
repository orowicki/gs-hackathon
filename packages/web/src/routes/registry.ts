import type { RouteDef } from "./types";

const DEFAULT_ORDER = 100;

export function collectRoutes(
  modules: Record<string, { default: RouteDef }>,
): RouteDef[] {
  const seen = new Map<string, string>();
  const defs: RouteDef[] = [];
  for (const [file, mod] of Object.entries(modules)) {
    const def = mod.default;
    const prev = seen.get(def.path);
    if (prev !== undefined) {
      throw new Error(
        `Duplicate route path "${def.path}" in ${prev} and ${file}`,
      );
    }
    seen.set(def.path, file);
    defs.push(def);
  }
  return defs.sort(
    (a, b) =>
      (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) ||
      a.path.localeCompare(b.path),
  );
}

export const routes = collectRoutes(
  import.meta.glob<{ default: RouteDef }>("./*.route.tsx", { eager: true }),
);
