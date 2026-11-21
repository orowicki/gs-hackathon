import { expect, test, type Page } from "@playwright/test";

async function mock(page: Page, decisions: unknown[]) {
  let pending = [{ alertId: "a1", runbookId: "rb1", stepIndex: 1, stepName: "Escalate to counterparty-support", requestedAt: new Date().toISOString() }];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    if (p === "/api/approvals") return route.fulfill({ json: pending });
    if (p === "/api/people")
      return route.fulfill({ json: [{ id: "p1", name: "Ada Admin", role: "SRE" }, { id: "p2", name: "Vera Viewer", role: "Support" }] });
    if (p === "/api/groups") return route.fulfill({ json: [{ id: "oncall", name: "Settlements on-call", memberIds: ["p1"] }, { id: "cps", name: "Counterparty support", memberIds: [] }] });
    if (p === "/api/alerts/a1") return route.fulfill({ json: { id: "a1", title: "Settlement failed at book-trade", severity: "critical" } });
    if (p === "/api/runbooks/rb1")
      return route.fulfill({
        json: { id: "rb1", name: "Settlement workflow timeout", steps: [{ name: "Retry", action: "http" }, { name: "Escalate", action: "escalate", group: "cps", approval: "required", approvers: "oncall" }] },
      });
    if (p === "/api/alerts/a1/runbook-steps/1/approve") {
      decisions.push(req.postDataJSON());
      pending = [];
      return route.fulfill({ json: { runbookId: "rb1", status: "running" } });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
}

test("approvals: a member approves from the inbox; others can't", async ({ page }) => {
  const decisions: unknown[] = [];
  await mock(page, decisions);
  await page.addInitScript(() => localStorage.setItem("alerting.mockSession", "p2"));
  await page.goto("/approvals");
  await expect(page.getByText("Settlement failed at book-trade")).toBeVisible();
  await expect(page.getByText("Escalates the alert to Counterparty support.")).toBeVisible();
  await expect(page.getByText("Vera Viewer isn't in this group")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
});

test("approvals: approving sends the decision and clears the item", async ({ page }) => {
  const decisions: unknown[] = [];
  await mock(page, decisions);
  await page.addInitScript(() => localStorage.setItem("alerting.mockSession", "p1"));
  await page.goto("/approvals");
  await expect(page.getByRole("link", { name: /Approvals/ })).toContainText("1");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText('Approved "Escalate to counterparty-support". It is running now.')).toBeVisible();
  expect(decisions).toEqual([{ runbookId: "rb1", decision: "approve" }]);
  await expect(page.getByText("Nothing is waiting for approval.")).toBeVisible();
});
