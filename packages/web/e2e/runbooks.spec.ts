import { expect, test } from "@playwright/test";

test("runbooks: list, start from an example, add an approval step, save", async ({ page }) => {
  const saved: Record<string, unknown>[] = [];
  const runbooks: Record<string, unknown>[] = [
    { id: "checklist", name: "Card checklist", type: "text", matches: "type = PAYMENT_DECLINED", content: "1. Check" },
  ];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/api/runbooks" && req.method() === "GET") return route.fulfill({ json: runbooks });
    if (p === "/api/runbooks" && req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      saved.push(body);
      runbooks.push(body);
      return route.fulfill({ status: 201, json: body });
    }
    if (p === "/api/groups") return route.fulfill({ json: [{ id: "settlements-oncall", name: "Settlements on-call" }] });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/config/runbooks");
  await expect(page.getByRole("link", { name: "Card checklist" })).toBeVisible();
  await expect(page.getByText("Instructions", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "New runbook" }).click();
  await page.getByRole("radio", { name: /Start from an example/ }).click();
  await page.getByRole("button", { name: /Escalate unhandled critical alerts/ }).click();
  await expect(page.getByRole("group", { name: "Step 1" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Step 2" })).toBeVisible();

  // Add an HTTP step that needs approval from on-call.
  await page.getByRole("button", { name: "HTTP call" }).last().click();
  const step3 = page.getByRole("group", { name: "Step 3" });
  await step3.getByLabel("Step name").fill("Open an incident ticket");
  await step3.getByLabel("URL").fill("https://ops.internal/tickets");
  await step3.getByText("Needs a person's approval before it runs").click();
  await step3.getByLabel("Approvers for step 3").selectOption("settlements-oncall");
  await expect(page.getByText("Runs 3 steps; 1 waits for approval.")).toBeVisible();

  await page.getByRole("button", { name: "Save runbook" }).click();
  await expect(page.getByRole("link", { name: "Escalate unhandled critical alerts" })).toBeVisible();
  expect(saved[0]).toMatchObject({
    id: "escalate-critical",
    type: "automation",
    matches: "alert.severity = critical",
    steps: [
      { action: "wait", duration: "5m" },
      { action: "escalate", group: "settlements-oncall" },
      { action: "http", method: "POST", url: "https://ops.internal/tickets", approval: "required", approvers: "settlements-oncall" },
    ],
  });
  expect(JSON.stringify(saved[0])).not.toContain('"key"');
});
