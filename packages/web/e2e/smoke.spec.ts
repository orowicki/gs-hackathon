import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");
const FILTER = "alert.status = nonsense";

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    const shot = (page: import("@playwright/test").Page, name: string) =>
      page.screenshot({ path: path.join(shots, `shell-${name}-${scheme}.png`) });

    test("landing", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Filter" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Star filter" })).toBeVisible();
      await expect(page.getByRole("button", { name: "New rule" })).toBeVisible();
      await expect(page.locator(".alert-list .row").first()).toBeVisible();
      await page.keyboard.press("/");
      await expect(page.getByRole("combobox", { name: "Filter" })).toBeFocused();
      await page.getByRole("combobox", { name: "Filter" }).blur();
      await shot(page, "landing");
    });

    test("filter in url", async ({ page }) => {
      await page.goto(`/?q=${encodeURIComponent(FILTER)}`);
      await expect(page.getByRole("combobox", { name: "Filter" })).toHaveValue(FILTER);
      await expect(page.getByText("No alerts match this filter.")).toBeVisible();
      await shot(page, "filter");
      await page.getByRole("button", { name: "Clear filter" }).click();
      await expect(page).toHaveURL(/\/$/);
      await page.getByRole("combobox", { name: "Filter" }).fill("a b");
      await expect(page).toHaveURL(/\?q=a\+b$/);
    });

    test("settings panel", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Settings" }).click();
      for (const h of ["Profile", "Notifications", "Theme", "Starred filters"]) {
        await expect(page.getByRole("heading", { name: h })).toBeVisible();
      }
      await shot(page, "settings");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "Profile" })).toHaveCount(0);
    });

    test("new rule", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "New rule" }).click();
      await expect(page).toHaveURL(/\/rules\/new$/);
      await expect(page.getByRole("heading", { name: "New rule" })).toBeVisible();
      await shot(page, "rules-new");
    });
  });
}
