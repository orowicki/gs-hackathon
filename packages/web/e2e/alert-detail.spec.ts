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
  await page.route("**/api/alerts/alert-wf-00042/unack", (r) => r.fulfill({ json: { ...alert, state: "open" } }));
  await page.route("**/api/rules/rule-settlements/runbook", (r) => r.fulfill({ status: 404, json: { error: "none" } }));
  await page.route("**/api/alerts/alert-wf-00042/runbook-runs", (r) => r.fulfill({ status: 404, json: {} }));
  await page.route("**/api/alerts/alert-wf-00042/audit", (r) => r.fulfill({ status: 404, json: {} }));
  await page.route("**/api/alerts/alert-wf-00042/runbooks", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/alerts/alert-wf-00042/suggestions", (r) => {
    suggestions.push(r.request().postDataJSON());
    return r.fulfill({ json: { id: "s1" } });
  });
}

test("runbooks: run now, approve, live steps", async ({ page }) => {
  let started = false;
  let approved = false;
  const steps = (states: string[]) =>
    states.map((state, index) => ({ index, state, name: ["Check health", "Retry WF-20261023-00042", "Tell on-call"][index] }));
  await mock(page, []);
  await page.route("**/api/alerts/alert-wf-00042/runbooks", (r) =>
    r.fulfill({
      json: [
        {
          id: "rule-rule-settlements",
          name: "Settlement recovery",
          type: "automation",
          origin: "rule",
          steps: [
            { index: 0, name: "Check health", action: "http", approval: "none" },
            { index: 1, name: "Retry WF-20261023-00042", action: "http", approval: "required" },
            { index: 2, name: "Tell on-call", action: "escalate", approval: "none" },
          ],
        },
        { id: "notes", name: "What to check", type: "text", origin: "config", content: "Look at the counterparty dashboard." },
      ],
    }),
  );
  await page.unroute("**/api/alerts/alert-wf-00042/runbook-runs");
  await page.route("**/api/alerts/alert-wf-00042/runbook-runs", (r) => {
    if (r.request().method() === "POST") {
      started = true;
      return r.fulfill({ json: { runbookId: "rule-rule-settlements", status: "awaiting_approval", steps: steps(["done", "awaiting_approval", "pending"]) } });
    }
    return r.fulfill({ json: [] });
  });
  await page.route("**/api/alerts/alert-wf-00042/runbook-steps/1/approve", (r) => {
    approved = true;
    return r.fulfill({ json: { runbookId: "rule-rule-settlements", status: "done", steps: steps(["done", "done", "done"]) } });
  });
  await page.goto("/alerts/alert-wf-00042");
  await expect(page.getByText("Look at the counterparty dashboard.")).toBeVisible();
  await expect(page.locator(".step-not_run")).toHaveCount(3);
  await page.getByRole("button", { name: /Run now/ }).click();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  expect(started).toBe(true);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".step-done")).toHaveCount(3);
  expect(approved).toBe(true);
});

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
      await expect(page.getByText(/No runbook applies to this alert/)).toBeVisible();
      // The audit log is folded away until opened.
      await expect(page.getByText("No audit entries yet.")).toHaveCount(0);
      await page.getByRole("button", { name: /Audit log/ }).click();
      await expect(page.getByText("No audit entries yet.")).toBeVisible();
      await expect(page.getByRole("link", { name: /Back to alerts/ })).toHaveAttribute("href", "/");

      const fieldText = await page.locator(".event .fields").first().innerText();
      expect(fieldText).not.toMatch(/[{}[\]"]/);

      await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
      const ackBtn = page.getByRole("button", { name: "Acknowledged" });
      await expect(ackBtn).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("alert-state")).toHaveText("acknowledged");
      // The same button undoes it, and keeps its width in both states.
      const ackedWidth = (await ackBtn.boundingBox())!.width;
      await ackBtn.click();
      await expect(page.getByTestId("alert-state")).toHaveText("open");
      const openBtn = page.getByRole("button", { name: "Acknowledge", exact: true });
      await expect(openBtn).toHaveAttribute("aria-pressed", "false");
      expect((await openBtn.boundingBox())!.width).toBe(ackedWidth);
      await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
      await expect(page.getByTestId("alert-state")).toHaveText("acknowledged");

      // The big text box only appears when saving to the rulebook.
      await page.getByRole("button", { name: /Resolve/ }).click();
      await expect(page.getByLabel("How was it resolved?")).toHaveCount(0);
      await page.getByText("Save to the rulebook").click();
      await expect(page.getByLabel("How was it resolved?")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();

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
