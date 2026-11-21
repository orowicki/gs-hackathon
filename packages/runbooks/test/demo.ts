export interface Demo {
  url: string;
  calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }>;
  setHealthy(v: boolean): void;
  reset(): void;
  close(): Promise<void>;
}
export async function loadDemo(): Promise<Demo> {
  const href = new URL("../../../fixtures/demo-service/server.mjs", import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ href)) as { startDemoService(): Promise<Demo> };
  return mod.startDemoService();
}
