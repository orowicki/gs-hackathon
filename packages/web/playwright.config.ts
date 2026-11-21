import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  // actionTimeout: a stuck click/fill fails with the step and the reason (e.g. "intercepts pointer
  // events") instead of only "Test timeout of 30000ms exceeded".
  use: { baseURL: "http://localhost:4173", viewport: { width: 1280, height: 800 }, actionTimeout: 10_000 },
  webServer: {
    command: "npm run build && npm run preview -- --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
