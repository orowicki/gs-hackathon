import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

interface Src {
  id: string;
  name: string;
  enabled: boolean;
  parser: { type: string; pattern?: string };
  type: string;
  config: Record<string, unknown>;
}

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

// Fixtures equal to what GET /api/source-types serves (packages/ingest/src/plugins/schemas.ts).
const SOURCE_TYPES_RESPONSE = {
  sourceTypes: [
    {
      type: "http",
      configSchema: { $schema: DRAFT, type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "file_tail",
      configSchema: {
        $schema: DRAFT,
        type: "object",
        properties: { path: { type: "string", title: "Path or glob", minLength: 1 } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      type: "redis_stream",
      configSchema: {
        $schema: DRAFT,
        type: "object",
        properties: {
          stream: { type: "string", title: "Stream key", minLength: 1 },
          consumerGroup: { type: "string", title: "Consumer group", minLength: 1 },
        },
        required: ["stream", "consumerGroup"],
        additionalProperties: false,
      },
    },
  ],
  parserConfigSchema: {
    $schema: DRAFT,
    type: "object",
    properties: {
      type: { type: "string", enum: ["json", "logfmt", "regex", "raw"] },
      pattern: { type: "string", title: "Regex with named groups (regex parser only)" },
    },
    required: ["type"],
    additionalProperties: false,
  },
};

const YAML = "id: web-logs\nname: Web logs\nenabled: true\n";

async function mockApi(page: Page) {
  const sources: Src[] = [
    { id: "edge-http", name: "Edge HTTP", enabled: true, parser: { type: "json" }, type: "http", config: {} },
    {
      id: "app-logs",
      name: "App logs",
      enabled: true,
      parser: { type: "logfmt" },
      type: "file_tail",
      config: { path: "/var/log/app.log" },
    },
  ];
  const imported: string[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/source-types" && m === "GET") return json(200, SOURCE_TYPES_RESPONSE);
    if (p === "/api/sources" && m === "GET") return json(200, sources);
    if (p === "/api/sources" && m === "POST") {
      const s = req.postDataJSON() as Src;
      sources.push(s);
      return json(201, s);
    }
    if (p === "/api/sources/test") {
      const b = req.postDataJSON() as { sample: string };
      return json(200, { parsed: Object.fromEntries(b.sample.split(" ").map((kv) => kv.split("="))) });
    }
    if (p === "/api/sources/import") {
      imported.push(req.postData() ?? "");
      expect(req.headers()["content-type"]).toContain("application/yaml");
      return json(200, { id: "web-logs", name: "Web logs", enabled: true, parser: { type: "json" }, type: "http", config: {} });
    }
    const pv = p.match(/^\/api\/sources\/([^/]+)\/preview$/);
    if (pv) {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: "level=error msg=boom"\n\ndata: "level=info msg=ok"\n\n',
      });
    }
    if (/\/export$/.test(p)) return route.fulfill({ status: 200, contentType: "application/yaml", body: YAML });
    const one = p.match(/^\/api\/sources\/([^/]+)$/);
    if (one && m === "GET") {
      const s = sources.find((x) => x.id === one[1]);
      return s ? json(200, s) : json(404, { error: "not found" });
    }
    return json(404, { error: "unmocked " + p });
  });
  return { sources, imported };
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("sources list, add, edit, export, import", async ({ page }) => {
      const { sources } = await mockApi(page);
      await page.goto("/config/sources");
      await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Edge HTTP" })).toBeVisible();
      await expect(page.getByRole("link", { name: "App logs" })).toBeVisible();
      await page.screenshot({ path: path.join(shots, `sources-list-${scheme}.png`), fullPage: true });

      // New source: choose a way, then the step-by-step editor.
      await page.getByRole("link", { name: "New source" }).click();
      await page.getByRole("radio", { name: /Build step by step/ }).click();
      await page.getByLabel("Id", { exact: true }).fill("test");
      await page.getByLabel("Name", { exact: true }).fill("Nope");
      await page.getByRole("button", { name: "Save source" }).click();
      await expect(page.getByText('"test" is reserved').first()).toBeVisible();

      await page.getByLabel("Id", { exact: true }).fill("new-file");
      await page.getByLabel("Name", { exact: true }).fill("New file");
      await page.getByRole("radio", { name: /File tail/ }).click();
      await expect(page.getByLabel("Path or glob")).toBeVisible();
      await page.getByRole("button", { name: "Save source" }).click();
      await expect(page.getByText("This field is required.")).toBeVisible();
      await page.getByLabel("Path or glob").fill("/tmp/x.log");
      await page.getByRole("radio", { name: "logfmt" }).click();
      await page.getByLabel("Sample line").fill("level=warn msg=hi");
      await expect(page.getByLabel("Parsed result")).toContainText("warn");
      await page.getByRole("button", { name: "Save source" }).click();
      await expect(page.getByRole("link", { name: "New file" })).toBeVisible();
      expect(sources.at(-1)).toMatchObject({ id: "new-file", type: "file_tail", config: { path: "/tmp/x.log" }, parser: { type: "logfmt" } });

      // Edit: same editor, live messages, export.
      await page.getByRole("link", { name: "App logs" }).click();
      await expect(page.getByRole("heading", { name: "App logs" })).toBeVisible();
      await expect(page.getByLabel("Path or glob")).toHaveValue("/var/log/app.log");
      await expect(page.getByText("level=error msg=boom")).toBeVisible();
      await expect(page.getByText("level=info msg=ok")).toBeVisible();
      await page.screenshot({ path: path.join(shots, `sources-edit-${scheme}.png`), fullPage: true });
      await page.getByRole("button", { name: "Export YAML" }).click();
      await expect(page.getByLabel("Exported YAML")).toContainText("name: Web logs");

      // Import: paste YAML, review in the editor, then save.
      await page.getByRole("link", { name: "Back to sources" }).click();
      await page.getByRole("link", { name: "Import YAML" }).click();
      await page.getByLabel("Source YAML").fill(YAML);
      await page.getByRole("button", { name: "Review source" }).click();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Web logs");
      await expect(page.getByText("Imported. Check the source below, then save it.")).toBeVisible();
      await page.getByRole("button", { name: "Save source" }).click();
      await expect(page.getByRole("link", { name: "Web logs" })).toBeVisible();
    });
  });
}
