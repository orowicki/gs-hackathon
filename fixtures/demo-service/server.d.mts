export interface DemoCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  at: string;
}
export interface DemoService {
  url: string;
  port: number;
  calls: DemoCall[];
  /** Clears recorded calls and restores healthy. */
  reset(): void;
  setHealthy(healthy: boolean): void;
  close(): Promise<void>;
}
export function startDemoService(opts?: { port?: number; host?: string }): Promise<DemoService>;
