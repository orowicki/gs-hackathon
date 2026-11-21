export interface DemoCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  at: string;
  seq: number;
  status?: number;
  response?: unknown;
}
export interface DemoService {
  url: string;
  port: number;
  calls: DemoCall[];
  /** Clears recorded calls and restores every switch to its default. */
  reset(): void;
  setHealthy(healthy: boolean): void;
  /** POST /workflows/:id/retry answers 500 while true. */
  setRetryFails(fails: boolean): void;
  /** GET /regions/:service reports errors in one region or in all of them. */
  setScope(scope: "one-region" | "all-regions"): void;
  /** GET /latency/:instance reports a p99 over 1000 ms while true. */
  setLatencyHigh(high: boolean): void;
  close(): Promise<void>;
}
export function startDemoService(opts?: { port?: number; host?: string }): Promise<DemoService>;
