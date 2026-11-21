import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

const rule = {
  id: "r1",
  name: "Critical prod alerts",
  enabled: true,
  when: "alert.severity = critical",
  who: [{ condition: "alert.environment = prod", recipients: [{ type: "group", id: "oncall" }], force: ["sms"] }],
  looks: { titleTemplate: "{{alert.title}}", fields: ["alert.source"] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

async function mock(page: Page) {
  const suggestions = [
    { id: "s1", ruleId: "r1", author: "ana", text: "Also page the DBA group", status: "open", createdAt: "2026-01-02T00:00:00Z" },
    { id: "s2", ruleId: "r1", author: "bo", text: "Old idea", status: "dismissed", createdAt: "2026-01-02T00:00:00Z" },
  ];
  await page.route("**/api/rules", (r) => r.fulfill({ json: [rule] }));
  await page.route("**/api/rules/r1", (r) => r.fulfill({ json: rule }));
  await page.route("**/api/rules/r1/suggestions", (r) => r.fulfill({ json: suggestions }));
  await page.route("**/api/rules/r1/export", (r) =>
    r.fulfill({ contentType: "application/yaml", body: "id: r1\nname: Critical prod alerts\n" }),
  );
  await page.route("**/api/events/test-filter", (r) => r.fulfill({ json: { matched: 3, total: 40 } }));
  await page.route("**/api/suggestions/s1/accept", (r) => r.fulfill({ json: { id: "s1", status: "accepted" } }));
  await page.route("**/api/suggestions/s1/dismiss", (r) => r.fulfill({ json: { id: "s1", status: "dismissed" } }));
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`rules ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 1000 } });

    test("list, editor, test filter, suggestions", async ({ page }) => {
      await mock(page);
      await page.goto("/rules");
      await expect(page.getByRole("link", { name: "Critical prod alerts" })).toBeVisible();
      await expect(page.getByRole("link", { name: "New rule" })).toBeVisible();

      await page.getByRole("link", { name: "Critical prod alerts" }).click();
      await expect(page).toHaveURL(/\/rules\/r1$/);
      for (const h of ["When", "Who", "Looks"]) await expect(page.getByRole("heading", { name: h, exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Test against recent events" }).click();
      await expect(page.getByText("Matches 3 of 40 recent events")).toBeVisible();

      await expect(page.getByText("Also page the DBA group")).toBeVisible();
      await expect(page.getByText("Old idea")).toHaveCount(0);
      await page.screenshot({ path: path.join(shots, `rules-${scheme}.png`), fullPage: true });

      await page.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByText("Also page the DBA group")).toHaveCount(0);
    });
  });
}
