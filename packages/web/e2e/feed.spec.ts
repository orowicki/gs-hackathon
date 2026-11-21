import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

// Without a backend the page falls back to the fixture-backed mock source.
for (const scheme of ["light", "dark"] as const) {
  test.describe(`feed ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("landing page feed", async ({ page }) => {
      await page.goto("/");
      const rows = page.locator(".alert-list .row");
      await expect(rows.first()).toBeVisible();
      const total = await rows.count();
      expect(total).toBeGreaterThan(3);

      const filter = page.getByRole("textbox", { name: "Filter" });
      await filter.fill("alert.severity =");
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(rows).toHaveCount(total);

      await filter.fill("alert.severity = critical");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(rows).not.toHaveCount(total);
      await expect(page).toHaveURL(/\?q=alert\.severity/);
      await expect(rows.first().locator(".sev-label")).toHaveText("CRIT");

      await filter.fill("alert.status = nonsense");
      await expect(page.getByText("No alerts match this filter.")).toBeVisible();
      await page.getByRole("button", { name: "Clear filter" }).click();
      await expect(rows).toHaveCount(total);

      const head = rows.first().locator("[data-row-head]");
      await head.click();
      await expect(head).toHaveAttribute("aria-expanded", "true");
      await expect(rows.first().getByRole("link", { name: "Open" })).toBeVisible();
      await expect(rows.first().getByText("Environment")).toBeVisible();

      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("radiogroup", { name: "Profile" })).toBeVisible();
      await expect(page.getByRole("radio").first()).toBeVisible();
      await page.keyboard.press("Escape");

      await page.screenshot({ path: path.join(shots, `feed-${scheme}.png`) });
    });
  });
}
