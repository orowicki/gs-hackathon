import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/screenshots",
);

interface Mapping {
  kind: "path" | "constant" | "template";
  path?: string;
  value?: string;
  template?: string;
  valueMap?: Record<string, string>;
  default?: string;
}
interface Sch {
  id: string;
  name: string;
  match: string;
  mapping: Record<string, Mapping>;
}

const SAMPLE = JSON.stringify(
  {
    type: "WORKFLOW_FAILED",
    workflowId: "WF-20261023-00042",
    workflowName: "order-settlement",
    step: "validate-counterparty",
    severity: "ERROR",
    environment: "prod",
    timestamp: "2026-10-23T09:14:02.331Z",
    error: {
      code: "TIMEOUT",
      message: "Counterparty service did not respond in 5000 ms",
    },
  },
  null,
  2,
);

const YAML =
  'id: schema-workflow-failed\nname: Workflow failed\nmatch: type = "WORKFLOW_FAILED"\n';

function get(obj: unknown, p: string): unknown {
  return p
    .split(".")
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown> | undefined)?.[k],
      obj,
    );
}

async function mockApi(page: Page) {
  const schemas: Sch[] = [
    {
      id: "schema-workflow-failed",
      name: "Workflow failed",
      match: 'type = "WORKFLOW_FAILED"',
      mapping: {
        severity: { kind: "path", path: "severity" },
        title: { kind: "path", path: "workflowName" },
      },
    },
    {
      id: "schema-metric-breach",
      name: "Metric breach",
      match: 'type = "METRIC_BREACH"',
      mapping: { title: { kind: "path", path: "metric" } },
    },
  ];
  const imported: string[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const m = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (p === "/api/filters/parse")
      return json(200, { tree: { op: "and", args: [] } });
    if (p === "/api/schemas/test") {
      const b = req.postDataJSON() as {
        schema: Sch;
        sample: Record<string, unknown>;
      };
      const common: Record<string, string> = {};
      for (const [k, mp] of Object.entries(b.schema.mapping)) {
        let v =
          mp.kind === "path"
            ? get(b.sample, mp.path ?? "")
            : mp.kind === "constant"
              ? mp.value
              : mp.template;
        v = v === undefined || v === "" ? mp.default : v;
        if (typeof v === "string") common[k] = mp.valueMap?.[v] ?? v;
      }
      return json(200, { matched: true, common });
    }
    if (p === "/api/schemas/import") {
      imported.push(req.postData() ?? "");
      expect(req.headers()["content-type"]).toContain("application/yaml");
      return json(200, schemas[0]);
    }
    if (p === "/api/schemas" && m === "GET") return json(200, schemas);
    if (p === "/api/schemas" && m === "POST") {
      const s = req.postDataJSON() as Sch;
      schemas.push(s);
      return json(201, s);
    }
    if (/\/export$/.test(p))
      return route.fulfill({
        status: 200,
        contentType: "application/yaml",
        body: YAML,
      });
    const one = p.match(/^\/api\/schemas\/([^/]+)$/);
    if (one && m === "GET") {
      const s = schemas.find((x) => x.id === one[1]);
      return s ? json(200, s) : json(404, { error: "not found" });
    }
    return json(404, { error: "unmocked " + p });
  });
  return { schemas, imported };
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });

    test("schemas list, click-to-map, save, export, import", async ({
      page,
    }) => {
      const { schemas, imported } = await mockApi(page);
      await page.goto("/config/schemas");
      await expect(
        page.getByRole("heading", { name: "Schemas" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Workflow failed" }),
      ).toBeVisible();
      await expect(page.getByText("schema-metric-breach")).toBeVisible();
      await page.screenshot({
        path: path.join(shots, `schemas-list-${scheme}.png`),
      });

      await page.getByRole("link", { name: "Add schema" }).click();
      await page.getByLabel("Id", { exact: true }).fill("schema-new");
      await page
        .getByLabel("Name", { exact: true })
        .fill("New workflow schema");
      await page.getByLabel("Match filter").fill('type = "WORKFLOW_FAILED"');
      await page.getByLabel("Sample event (JSON)").fill(SAMPLE);
      await expect(page.getByLabel("Map field error.code")).toBeVisible();

      await page.getByLabel("Common field to map").selectOption("severity");
      await page.getByLabel("Map field severity").click();
      await expect(page.getByLabel("Path for severity")).toHaveValue(
        "severity",
      );
      await page.getByLabel("Add value map pair to severity").click();
      await page.getByLabel("severity value map from 1").fill("ERROR");
      await page.getByLabel("severity value map to 1").fill("error");

      await page.getByLabel("Common field to map").selectOption("title");
      await page.getByLabel("Map field workflowName").click();
      await expect(page.getByLabel("Path for title")).toHaveValue(
        "workflowName",
      );
      await page.getByLabel("Default for title").fill("Workflow failed");

      await expect(page.getByText("Matches:")).toContainText("yes");
      const result = page.getByLabel("Mapped common fields");
      await expect(result).toContainText("error");
      await expect(result).toContainText("order-settlement");
      await page.screenshot({
        path: path.join(shots, `schemas-edit-${scheme}.png`),
        fullPage: true,
      });

      await page.getByRole("button", { name: "Save" }).click();
      await expect(
        page.getByRole("link", { name: "New workflow schema" }),
      ).toBeVisible();
      const saved = schemas.find((s) => s.id === "schema-new");
      expect(saved?.match).toBe('type = "WORKFLOW_FAILED"');
      expect(saved?.mapping.severity).toMatchObject({
        kind: "path",
        path: "severity",
        valueMap: { ERROR: "error" },
      });
      expect(saved?.mapping.title?.default).toBe("Workflow failed");

      await page.getByRole("link", { name: "Workflow failed" }).click();
      await expect(
        page.getByRole("heading", { name: "Edit schema" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Export YAML" }).click();
      await expect(page.getByLabel("Exported YAML")).toContainText(
        "name: Workflow failed",
      );

      await page.getByRole("link", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Import YAML" }).click();
      await page.getByLabel("Schema YAML").fill(YAML);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await expect.poll(() => imported.length).toBe(1);
      expect(imported[0]).toBe(YAML);
    });
  });
}
