import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

// Without a backend the page falls back to the fixture-backed mock source.
for (const scheme of ["light", "dark"] as const) {
  test.describe(`feed ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("landing page feed", async ({ page }) => {
      // The mock source pushes a new alert every 15 s (MOCK_PUSH_INTERVAL_MS); a tick mid-test
      // changes the row count. Disable that one interval so counts stay stable.
      await page.addInitScript(() => {
        const real = window.setInterval.bind(window);
        window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
          ms === 15_000 ? 0 : real(fn, ms, ...args)) as typeof window.setInterval;
      });
      await page.goto("/");
      const rows = page.locator(".alert-list .row");
      await expect(rows.first()).toBeVisible();
      // Rows render in more than one pass; take the count only once it stops changing.
      let total = -1;
      await expect
        .poll(async () => {
          const before = await rows.count();
          await page.waitForTimeout(300);
          const after = await rows.count();
          total = after;
          return before === after;
        })
        .toBe(true);
      expect(total).toBeGreaterThan(3);

      const filter = page.getByRole("combobox", { name: "Filter" });
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
      await expect(page.getByText("Signed in as")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      await page.keyboard.press("Escape");

      await page.screenshot({ path: path.join(shots, `feed-${scheme}.png`) });
    });
  });
}
