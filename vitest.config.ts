import { defineConfig } from "vitest/config";

// vitest >= 3.2 deprecates vitest.workspace.ts in favour of `projects`.
export default defineConfig({
  test: {
    projects: [
      "packages/*",
      { test: { name: "loadtest", include: ["scripts/loadtest/**/*.test.mjs"] } },
    ],
  },
});
