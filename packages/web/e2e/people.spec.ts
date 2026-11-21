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
      await expect(people.getByRole("cell", { name: "Ada Admin", exact: true })).toBeVisible();

      // create
      await page.getByRole("button", { name: "Add person" }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Bob Builder");
      await page.getByRole("textbox", { name: "Role", exact: true }).fill("Dev");
      await page.getByRole("textbox", { name: "Phone topic (ntfy)", exact: true }).fill("bob");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(people.getByRole("cell", { name: "Bob Builder", exact: true })).toBeVisible();

      // edit
      await page.getByRole("button", { name: "Edit Bob Builder" }).click();
      await page.getByRole("textbox", { name: "Role", exact: true }).fill("Lead");
      await page.getByRole("checkbox", { name: "Can create rules" }).check();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(people.getByRole("cell", { name: "Lead", exact: true })).toBeVisible();

      // group with a member
      await page.getByRole("button", { name: "Add group" }).click();
      await page.getByRole("textbox", { name: "Group name", exact: true }).fill("On-call");
      await page.getByRole("group", { name: "Members" }).getByLabel("Bob Builder").check();
      await page.getByRole("button", { name: "Save" }).click();
      const groups = page.getByRole("table", { name: "Groups" });
      await expect(groups.getByRole("cell", { name: "On-call", exact: true })).toBeVisible();
      await expect(groups.getByRole("cell", { name: "Bob Builder", exact: true })).toBeVisible();

      await page.screenshot({ path: path.join(shots, `people-${scheme}.png`) });

      // delete
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Delete Bob Builder" }).click();
      await expect(people.getByRole("cell", { name: "Bob Builder", exact: true })).toHaveCount(0);
    });

    test("load error is shown inline", async ({ page }) => {
      await page.route("**/api/people**", (r) => r.fulfill({ status: 404, body: "" }));
      await page.route("**/api/groups**", (r) => r.fulfill({ status: 404, body: "" }));
      await page.goto("/config/people");
      await expect(page.getByText("Couldn't load people (HTTP 404)")).toBeVisible();
    });
  });
}
