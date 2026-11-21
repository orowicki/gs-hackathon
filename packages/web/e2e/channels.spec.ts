import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

const channels = [
  { id: "ntfy", healthy: true, pending: 2, deadLetters: 0 },
  { id: "email", healthy: false, pending: 5, deadLetters: 2, lastError: "SMTP timeout" },
];

const mkLetter = (id: string, title: string) => ({
  id,
  error: "SMTP timeout",
  failedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  notification: {
    id,
    alertId: "a1",
    recipientId: "user-1",
    channel: "email",
    severity: "critical",
    title,
    clickUrl: "/alerts/a1",
    attempt: 5,
    createdAt: new Date().toISOString(),
  },
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("channels and dead letters", async ({ page }) => {
      let letters = [mkLetter("n1", "Disk full"), mkLetter("n2", "CPU high")];
      const retried: string[] = [];

      await page.route("**/api/channels", (r) => r.fulfill({ json: channels }));
      await page.route("**/api/dead-letters", (r) => r.fulfill({ json: letters }));
      await page.route("**/api/dead-letters/*/retry", (r) => {
        expect(r.request().method()).toBe("POST");
        const id = r.request().url().split("/").slice(-2)[0] ?? "";
        retried.push(id);
        const found = letters.find((l) => l.id === id);
        letters = letters.filter((l) => l.id !== id);
        return found
          ? r.fulfill({ json: found.notification })
          : r.fulfill({ status: 404, body: "not found" });
      });

      await page.goto("/config/channels");
      await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
      await expect(page.getByText("Healthy", { exact: true })).toBeVisible();
      await expect(page.getByText("Unhealthy", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry n1" })).toBeVisible();
      await page.screenshot({ path: path.join(shots, `channels-${scheme}.png`) });

      await page.getByRole("button", { name: "Retry n1" }).click();
      await expect(page.getByRole("button", { name: "Retry n1" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry n2" })).toBeVisible();
      expect(retried).toEqual(["n1"]);
    });
  });
}
