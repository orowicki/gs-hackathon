import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

test("mock mode: signed in by default, sign out, create an account, sign back in", async ({ page }) => {
  await page.goto("/?mock=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Signed in as")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText(/Demo mode/)).toBeVisible();
  await page.screenshot({ path: path.join(shots, "sign-in.png") });

  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Name").fill("Zoe Tester");
  await page.getByLabel("Role (optional)").fill("QA");
  await page.getByRole("button", { name: "Create and sign in" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Zoe Tester")).toBeVisible();
  await expect(page.getByText("Can't create rules.")).toBeVisible();

  // The new account stays in the list after signing out (kept in this browser).
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /Zoe Tester/ }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Zoe Tester")).toBeVisible();
});

test("server mode: sign-in page, POST /api/session, actor names on the alert page", async ({ page }) => {
  const people = [
    { id: "marek", name: "Marek Nowak", role: "Settlements on-call", canCreateRules: false },
    { id: "julia", name: "Julia Lis", role: "Team lead", canCreateRules: true },
  ];
  let signedIn: string | null = null;
  await page.route("**/api/session", async (r) => {
    const m = r.request().method();
    if (m === "POST") {
      signedIn = (r.request().postDataJSON() as { personId: string }).personId;
      return r.fulfill({ json: people.find((p) => p.id === signedIn) });
    }
    if (m === "DELETE") {
      signedIn = null;
      return r.fulfill({ status: 204 });
    }
    return signedIn
      ? r.fulfill({ json: people.find((p) => p.id === signedIn) })
      : r.fulfill({ status: 401, json: { error: "not signed in" } });
  });
  await page.route("**/api/people", (r) => r.fulfill({ json: people }));
  const alert = {
    id: "a1",
    ruleId: "r1",
    eventId: "e1",
    state: "acknowledged",
    acknowledgedBy: "julia",
    severity: "error",
    title: "Settlement failed at book-trade",
    rulebook: [{ id: "c1", ruleId: "r1", text: "Retry it.", updatedBy: "julia", updatedAt: new Date().toISOString() }],
  };
  await page.route("**/api/alerts/a1", (r) => r.fulfill({ json: alert }));
  await page.route("**/api/alerts/a1/*", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/rules/r1/runbook", (r) => r.fulfill({ status: 404, json: { error: "none" } }));

  await page.goto("/alerts/a1");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText(/Demo mode/)).toHaveCount(0);
  await page.getByRole("button", { name: /Marek Nowak/ }).click();
  expect(signedIn).toBe("marek");

  await expect(page.getByRole("heading", { name: alert.title })).toBeVisible();
  await expect(page.getByText("Acknowledged by Julia Lis")).toBeVisible();
  await expect(page.locator(".comment-meta strong")).toHaveText("Julia Lis");
  await expect(page.getByText("Commenting as Marek Nowak")).toBeVisible();
});
