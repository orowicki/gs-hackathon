import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

const PEOPLE = [
  { id: "p1", name: "Ada Lovelace", role: "SRE", canCreateRules: true, ntfyTopic: "ada" },
  { id: "p2", name: "Bob", role: "Dev", canCreateRules: false },
];

async function mockApi(page: Page, puts: unknown[]) {
  const prefs = new Map<string, unknown>();
  await page.route("**/api/people", (route) => route.fulfill({ json: PEOPLE }));
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: [
        { id: "ui", healthy: true, pending: 0, deadLetters: 0 },
        { id: "ntfy", healthy: true, pending: 0, deadLetters: 0 },
        { id: "email", healthy: false, pending: 2, deadLetters: 1, lastError: "SMTP down" },
      ],
    }),
  );
  await page.route("**/api/people/*/preferences", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as unknown;
      puts.push(body);
      prefs.set(id, body);
      return route.fulfill({ json: body });
    }
    const p = prefs.get(id);
    return p ? route.fulfill({ json: p }) : route.fulfill({ status: 404, json: { error: "not found" } });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("edit and save preferences", async ({ page }) => {
      const puts: unknown[] = [];
      await mockApi(page, puts);
      await page.addInitScript(() => localStorage.setItem("alerting.profile", "p1"));
      await page.goto("/settings/notifications");

      await expect(page.getByRole("heading", { name: "Notification preferences" })).toBeVisible();
      await expect(page.getByRole("main").getByText("Ada Lovelace")).toBeVisible();
      await expect(page.getByText(/defaults apply/)).toBeVisible();
      // Not in the sidebar any more; the breadcrumb names the page.
      await expect(page.getByRole("navigation", { name: "Main" }).getByText("My notifications")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Notification preferences");
      // Columns come from /api/channels, so Email shows up. Contact points and rules are not on this page.
      await expect(page.getByRole("checkbox", { name: "critical via Email" })).not.toBeChecked();
      await expect(page.getByRole("heading", { name: "Contact points" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Rules that notify you" })).toHaveCount(0);
      // defaults: ntfy topic present, so critical via ntfy is on
      await expect(page.getByRole("checkbox", { name: "critical via Phone" })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "info via Phone" })).not.toBeChecked();

      await page.getByRole("checkbox", { name: "critical via Phone" }).uncheck();
      await page.getByRole("checkbox", { name: "warning via Dashboard" }).uncheck();
      await page.getByRole("checkbox", { name: "Enable quiet hours" }).check();
      await page.getByLabel("From", { exact: true }).fill("23:00");
      await page.getByLabel("To", { exact: true }).fill("06:30");
      await page.getByLabel("Timezone", { exact: true }).selectOption("Europe/Berlin");
      await expect(page.getByText("Unsaved changes")).toBeVisible();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();

      expect(puts).toHaveLength(1);
      const body = puts[0] as {
        ownerType: string;
        ownerId: string;
        rules: { when: unknown; channels: string[] }[];
        quietHours: unknown;
      };
      expect(body.ownerType).toBe("person");
      expect(body.ownerId).toBe("p1");
      expect(body.rules[0]).toEqual({
        when: { type: "cmp", field: "alert.severity", op: "=", value: "critical" },
        channels: ["ui"],
      });
      expect(body.rules[2]).toEqual({
        when: { type: "cmp", field: "alert.severity", op: "=", value: "warning" },
        channels: [],
      });
      expect(body.quietHours).toEqual({ from: "23:00", to: "06:30", timezone: "Europe/Berlin", allowChannels: ["ui"] });

      await page.screenshot({ path: path.join(shots, `my-notifications-${scheme}.png`) });

      await page.reload();
      await expect(page.getByRole("checkbox", { name: "warning via Dashboard" })).not.toBeChecked();
      await expect(page.getByLabel("From", { exact: true })).toHaveValue("23:00");
    });

    test("follows the signed-in account", async ({ page }) => {
      await mockApi(page, []);
      // Signed in as Bob (mock mode keeps the session in this browser).
      await page.addInitScript(() => localStorage.setItem("alerting.mockSession", "p2"));
      await page.goto("/settings/notifications");
      await expect(page.getByRole("main").getByText("Bob")).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Profile" })).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem("alerting.profile"))).toBe(JSON.stringify("p2"));
    });
  });
}
