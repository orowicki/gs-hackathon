import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

interface P {
  id: string;
  name: string;
  role: string;
  canCreateRules: boolean;
  ntfyTopic?: string;
}
interface G {
  id: string;
  name: string;
  memberIds: string[];
}

/** In-memory mock of /api/people and /api/groups. */
async function mockApi(page: Page) {
  let seq = 100;
  const people: P[] = [{ id: "p1", name: "Ada Admin", role: "SRE", canCreateRules: true, ntfyTopic: "ada-alerts" }];
  const groups: G[] = [];
  for (const [kind, store] of [
    ["people", people],
    ["groups", groups],
  ] as const) {
    await page.route(`**/api/${kind}**`, async (route) => {
      const req = route.request();
      const id = new URL(req.url()).pathname.split("/")[3];
      const list = store as { id: string }[];
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      switch (req.method()) {
        case "GET":
          return json(id ? list.find((x) => x.id === id) : list);
        case "POST": {
          const e = { ...req.postDataJSON(), id: `n${seq++}` };
          list.push(e);
          return json(e, 201);
        }
        case "PUT": {
          const i = list.findIndex((x) => x.id === id);
          list[i] = { ...req.postDataJSON(), id };
          return json(list[i]);
        }
        case "DELETE": {
          const i = list.findIndex((x) => x.id === id);
          if (i >= 0) list.splice(i, 1);
          return route.fulfill({ status: 204 });
        }
        default:
          return route.fallback();
      }
    });
  }
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("people and groups", async ({ page }) => {
      await mockApi(page);
      await page.goto("/config/people");
      await expect(page.getByRole("heading", { name: "People & groups" })).toBeVisible();

      const people = page.getByRole("table", { name: "People" });
      await expect(people.getByText("Ada Admin", { exact: true })).toBeVisible();

      // create (in the side drawer)
      await page.getByRole("button", { name: "Add person" }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("textbox", { name: "Name", exact: true }).fill("Bob Builder");
      await drawer.getByRole("textbox", { name: "Role", exact: true }).fill("Dev");
      await drawer.getByRole("textbox", { name: "Phone topic (ntfy)", exact: true }).fill("bob");
      await drawer.getByRole("button", { name: "Save" }).click();
      await expect(people.getByRole("cell", { name: "Bob Builder", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // edit
      await page.getByRole("button", { name: "Edit Bob Builder" }).click();
      await drawer.getByRole("textbox", { name: "Role", exact: true }).fill("Lead");
      await drawer.getByRole("checkbox", { name: /Can create rules/ }).check();
      await drawer.getByRole("button", { name: "Save" }).click();
      await expect(people.getByRole("cell", { name: "Lead", exact: true })).toBeVisible();
      await expect(people.getByText("Creates rules")).toHaveCount(2);

      // search
      await page.getByRole("searchbox", { name: "Search people" }).fill("bob");
      await expect(people.getByRole("row")).toHaveCount(2);
      await page.getByRole("searchbox", { name: "Search people" }).fill("");

      // group with a member (Groups tab)
      await page.getByRole("tab", { name: /Groups/ }).click();
      await page.getByRole("button", { name: "Add group" }).click();
      await drawer.getByRole("textbox", { name: "Group name", exact: true }).fill("On-call");
      await drawer.getByRole("group", { name: /Members/ }).getByLabel("Bob Builder").check();
      await drawer.getByRole("button", { name: "Save" }).click();
      const groups = page.getByRole("table", { name: "Groups" });
      await expect(groups.getByRole("cell", { name: "On-call", exact: true })).toBeVisible();
      await expect(groups.getByRole("cell", { name: "Bob Builder", exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(shots, `groups-${scheme}.png`) });

      // the person's row lists the group
      await page.getByRole("tab", { name: /People/ }).click();
      await expect(people.getByText("On-call")).toBeVisible();
      await page.screenshot({ path: path.join(shots, `people-${scheme}.png`) });

      // delete
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Delete Bob Builder" }).click();
      await expect(people.getByRole("cell", { name: "Bob Builder", exact: true })).toHaveCount(0);
    });

    test("an account that can't create rules only views, and edits only itself", async ({ page }) => {
      await mockApi(page);
      await page.route("**/api/people", (r) =>
        r.request().method() === "GET"
          ? r.fulfill({
              json: [
                { id: "p1", name: "Ada Admin", role: "SRE", canCreateRules: true },
                { id: "p2", name: "Vera Viewer", role: "Support", canCreateRules: false },
              ],
            })
          : r.fallback(),
      );
      await page.addInitScript(() => localStorage.setItem("alerting.mockSession", "p2"));
      await page.goto("/config/people");
      await expect(page.getByText(/You can view people and groups/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Add person" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit Ada Admin" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete Ada Admin" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(0);
      await page.getByRole("button", { name: "Edit Vera Viewer" }).click();
      await expect(page.getByRole("dialog").getByRole("checkbox", { name: /Can create rules/ })).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: /Groups/ }).click();
      await expect(page.getByRole("button", { name: "Add group" })).toHaveCount(0);
    });

    test("load error is shown inline", async ({ page }) => {
      await page.route("**/api/people**", (r) => r.fulfill({ status: 404, body: "" }));
      await page.route("**/api/groups**", (r) => r.fulfill({ status: 404, body: "" }));
      await page.goto("/config/people");
      await expect(page.getByText("Couldn't load people (HTTP 404)")).toBeVisible();
    });
  });
}
