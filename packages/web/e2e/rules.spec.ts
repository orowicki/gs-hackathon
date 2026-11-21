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
  dedupFields: ["source"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

async function mock(page: Page, saves: unknown[] = []) {
  const suggestions = [
    { id: "s1", ruleId: "r1", author: "ana", text: "Also page the DBA group", status: "open", createdAt: "2026-01-02T00:00:00Z" },
    { id: "s2", ruleId: "r1", author: "bo", text: "Old idea", status: "dismissed", createdAt: "2026-01-02T00:00:00Z" },
  ];
  await page.route("**/api/rules", (r) => {
    if (r.request().method() === "POST") {
      saves.push(r.request().postDataJSON());
      return r.fulfill({ status: 201, json: r.request().postDataJSON() });
    }
    return r.fulfill({ json: [rule] });
  });
  await page.route("**/api/rules/r1", (r) => {
    if (r.request().method() === "PUT") {
      saves.push(r.request().postDataJSON());
      return r.fulfill({ json: r.request().postDataJSON() });
    }
    return r.fulfill({ json: rule });
  });
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
      const saves: Array<Record<string, unknown>> = [];
      await mock(page, saves);
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

      await page.getByRole("button", { name: "Save rule" }).click();
      await expect(page.getByText("Saved")).toBeVisible();
      expect(saves[0]).toMatchObject({ id: "r1", dedupFields: ["source"] });

      await page.goto("/rules/new");
      await page.getByRole("radio", { name: /Build step by step/ }).click();
      await page.getByLabel("Name", { exact: true }).fill("Brand New");
      await expect(page.getByLabel("Id", { exact: true })).toHaveValue("brand-new");
      await page.getByRole("button", { name: "Save rule" }).click();
      await expect.poll(() => saves.length).toBe(2);
      expect(saves[1]).toMatchObject({ id: "brand-new", name: "Brand New" });

      await page.goto("/rules/new");
      await page.getByRole("radio", { name: /Start from an example/ }).click();
      await page.getByRole("button", { name: /Failed settlement workflows/ }).click();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Failed settlement workflows");

      // Paste YAML opens the editor for review; nothing is saved until Save rule.
      await page.getByRole("radio", { name: /Paste YAML/ }).click();
      await page.getByLabel("Rule YAML").fill("id: pasted\nname: Pasted rule\nwhen: alert.severity = critical\n");
      await page.getByRole("button", { name: "Review rule" }).click();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Pasted rule");
      await expect(page.getByText("Imported. Check the rule below, then save it.")).toBeVisible();
      expect(saves.length).toBe(2);
      await page.getByRole("button", { name: "Save rule" }).click();
      await expect.poll(() => saves.length).toBe(3);
      expect(saves[2]).toMatchObject({ id: "pasted", name: "Pasted rule", when: "alert.severity = critical" });

      await page.goto("/rules/r1");
      await page.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByText("Also page the DBA group")).toHaveCount(0);
    });
  });
}
