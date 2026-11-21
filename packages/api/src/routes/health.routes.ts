import { send, type RouteModule } from "../http.js";

const CHECK_TIMEOUT_MS = 2000;

async function runCheck(fn: () => Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  name: "health",
  order: 10,
  async handle({ req, res, path, deps }) {
    if (req.method !== "GET" || path !== "/health") return false;
    const [postgres, redis] = await Promise.all([
      runCheck(deps.checkPostgres),
      runCheck(deps.checkRedis),
    ]);
    const ok = postgres && redis;
    send(res, ok ? 200 : 503, { ok, checks: { postgres, redis } });
    return true;
  },
} satisfies RouteModule;
