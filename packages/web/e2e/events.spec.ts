import { expect, test } from "@playwright/test";

const events = [
  {
    id: "e1",
    sourceId: "edge",
    receivedAt: new Date().toISOString(),
    raw: '{"invoice":{"id":"INV-1","status":"failed"}}',
    parsed: { invoice: { id: "INV-1", status: "failed" } },
    schemaId: null,
    common: {},
  },
  {
    id: "e2",
    sourceId: "edge",
    receivedAt: new Date().toISOString(),
    raw: "{}",
    parsed: { type: "WORKFLOW_FAILED" },
    schemaId: "wf",
    common: { title: "order-settlement failed" },
  },
];

test("events: list, not recognised, create a schema from an event", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/events") {
      const unrec = (u.searchParams.get("filter") ?? "").includes("NOT alert.schema");
      return route.fulfill({ json: unrec ? events.filter((e) => !e.schemaId) : events });
    }
    if (u.pathname === "/api/sources") return route.fulfill({ json: [{ id: "edge", name: "Edge HTTP" }] });
    if (u.pathname === "/api/schemas") return route.fulfill({ json: [{ id: "wf", name: "Workflow failed" }] });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/events");
  await expect(page.getByText("order-settlement failed")).toBeVisible();
  await expect(page.getByText("invoice.id=INV-1")).toBeVisible();

  await page.getByRole("radio", { name: "Not recognised" }).click();
  await expect(page.getByText("order-settlement failed")).toHaveCount(0);
  await page.getByText("invoice.id=INV-1").click();
  await page.getByRole("button", { name: "Create schema from this event" }).click();

  await expect(page).toHaveURL(/\/config\/schemas\/new\?mode=editor&from=event/);
  await expect(page.getByText("Started from an event from Edge HTTP")).toBeVisible();
  await expect(page.getByLabel("Sample event (JSON)")).toHaveValue(/INV-1/);
});
