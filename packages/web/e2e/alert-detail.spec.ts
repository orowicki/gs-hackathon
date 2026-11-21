import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

const now = Date.now();
const alert = {
  id: "alert-wf-00042",
  ruleId: "rule-settlements",
  eventId: "evt-workflow-failed",
  dedupKey: "order-settlement-validate-counterparty",
  state: "open",
  severity: "error",
  title: "order-settlement failed at validate-counterparty",
  source: "order-settlement",
  environment: "prod",
  count: 3,
  firstSeen: new Date(now - 150_000).toISOString(),
  lastSeen: new Date(now - 120_000).toISOString(),
  common: {
    severity: "error",
    title: "order-settlement failed at validate-counterparty",
    source: "order-settlement",
    environment: "prod",
    dedupKey: "order-settlement-validate-counterparty",
    status: "firing",
    occurredAt: new Date(now - 150_000).toISOString(),
  },
  event: {
    parsed: {
      type: "WORKFLOW_FAILED",
      workflowId: "WF-20261023-00042",
      workflowName: "order-settlement",
      step: "validate-counterparty",
      severity: "ERROR",
      environment: "prod",
      timestamp: new Date(now - 150_000).toISOString(),
      amount: 25000000,
      retried: false,
      error: { code: "TIMEOUT", message: "Counterparty service did not respond in 5000 ms" },
    },
  },
};

async function mock(page: Page, suggestions: unknown[]) {
  await page.route("**/api/alerts/alert-wf-00042", (r) => r.fulfill({ json: alert }));
  await page.route("**/api/alerts/alert-wf-00042/ack", (r) => r.fulfill({ json: { ...alert, state: "acknowledged" } }));
  await page.route("**/api/alerts/alert-wf-00042/runbook-runs", (r) => r.fulfill({ status: 404, json: {} }));
  await page.route("**/api/alerts/alert-wf-00042/audit", (r) => r.fulfill({ status: 404, json: {} }));
  await page.route("**/api/alerts/alert-wf-00042/suggestions", (r) => {
    suggestions.push(r.request().postDataJSON());
    return r.fulfill({ json: { id: "s1" } });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`alert detail ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });

    test("renders, acknowledges, suggests", async ({ page }) => {
      const suggestions: unknown[] = [];
      await mock(page, suggestions);
      await page.goto("/alerts/alert-wf-00042");

      await expect(page.getByRole("heading", { name: alert.title })).toBeVisible();
      await expect(page.getByText("Workflow ID", { exact: true })).toBeVisible();
      await expect(page.getByText("25,000,000")).toBeVisible();
      await expect(page.getByText("No runbook runs yet.")).toBeVisible();
      await expect(page.getByText("No audit entries yet.")).toBeVisible();
      await expect(page.getByRole("link", { name: /Back to alerts/ })).toHaveAttribute("href", "/");

      const fieldText = await page.locator(".event .fields").first().innerText();
      expect(fieldText).not.toMatch(/[{}[\]"]/);

      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(page.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
      await expect(page.getByTestId("alert-state")).toHaveText("acknowledged");

      await page.getByRole("button", { name: "Suggest a change" }).click();
      const send = page.getByRole("button", { name: "Send" });
      await expect(send).toBeDisabled();
      await page.getByRole("textbox", { name: "Suggestion" }).fill("Raise the timeout threshold");
      await send.click();
      await expect(page.getByText("Suggestion sent")).toBeVisible();
      expect(suggestions).toEqual([{ text: "Raise the timeout threshold" }]);

      await page.screenshot({ path: path.join(shots, `alert-detail-${scheme}.png`), fullPage: true });
    });

    test("not found", async ({ page }) => {
      await page.route("**/api/alerts/nope", (r) => r.fulfill({ status: 404, json: { error: "not found" } }));
      await page.goto("/alerts/nope");
      await expect(page.getByText("Alert not found.")).toBeVisible();
    });
  });
}
