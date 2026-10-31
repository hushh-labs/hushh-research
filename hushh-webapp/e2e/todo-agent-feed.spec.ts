import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Production TodoListPage + persistence adapter. Only session/provider/storage
// boundaries are isolated; no real owner, Calendar or Gmail records are changed.
let script: string;
let css: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-agent-flow-"));
  const boundary = path.join(
    root,
    "e2e/fixtures/todo-agent-feed-boundaries.tsx",
  );
  const overrides: Record<string, string> = {
    "hooks/use-auth.ts": "useAuth",
    "lib/vault/vault-context.tsx": "useVault",
    "lib/feed/use-feed-actionables.ts": "useFeedActionables",
    "lib/feed/use-feed-briefing.ts": "useFeedBriefing",
    "lib/calendar/use-calendar-connection-status.ts":
      "useCalendarConnectionStatus",
    "lib/profile/gmail-connector-store.ts": "useGmailConnectorStatus",
    "lib/profile/gmail-receipts-cache.ts":
      "getCachedGmailReceipts,cachedGmailReceiptDisplayItems,clearCachedGmailReceipts",
    "lib/services/todo-capability-sources.ts": "readTodoCapabilities",
    "lib/services/todo-suggestion-service.ts":
      "todoSuggestionsAvailable,suggestTodoTasks",
    "lib/calendar/use-calendar-upcoming-events.ts": "useCalendarUpcomingEvents",
    "lib/services/personal-knowledge-model-service.ts":
      "PersonalKnowledgeModelService",
    "lib/services/pkm-write-coordinator.ts": "PkmWriteCoordinator",
    "lib/morphy-ux/morphy.ts": "morphyToast",
    "lib/morphy-ux/morphy.tsx": "morphyToast",
    "components/app-ui/app-page-shell.tsx":
      "AppPageShell,AppPageHeaderRegion,AppPageContentRegion",
  };
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    plugins: [
      {
        name: "todo-provider-boundaries",
        enforce: "pre",
        load(id) {
          const clean = id.split("?")[0];
          const relative = path.relative(root, clean).split(path.sep).join("/");
          if (overrides[relative])
            return `export {${overrides[relative]}} from ${JSON.stringify(boundary)};`;
          if (clean.endsWith("/node_modules/next/link.js"))
            return `export {default} from ${JSON.stringify(boundary)};`;
        },
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const token of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(token);
        },
      },
    ],
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/todo-agent-feed.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs
      .readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

for (const [width, dark] of [
  [320, false],
  [393, true],
  [1280, false],
] as const) {
  test(`agent Todo preview keeps Profile typography and compact rows at ${width}px${dark ? " dark" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://localhost/todo-fixture", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto("http://localhost/todo-fixture");
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Open agent Todo" }).click();
    const preview = page.locator('[data-profile-type-scale="todo"]');
    const title = preview.getByRole("heading", { name: "Review Alex's connection request", exact: true });
    await expect(title).toBeVisible();
    // This is the mounted agent-sheet path, outside the standalone page shell.
    expect(await preview.evaluate(element => element.closest(".app-page-shell"))).toBeNull();
    for (const [locator, size, weight] of [
      [preview.getByRole("heading", { name: "To-do list", exact: true }), "20px", "600"],
      [title, "13px", "400"],
      [preview.getByRole("heading", { name: "Any time", exact: true }), "10px", "600"],
      [preview.getByText("Up to 100 loaded summaries; no message content, card details or Memory content. Review before adding."), "12px", "400"],
      [preview.getByRole("link", { name: "Open Review Alex's connection request", exact: true }), "12px", "500"],
    ] as const) {
      await expect(locator).toHaveCSS("font-size", size);
      await expect(locator).toHaveCSS("font-weight", weight);
      await expect(locator).toHaveCSS("font-family", /Plus Jakarta Sans/);
    }
    for (const control of await preview.locator('button, a, summary, label').all()) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const row = preview.locator("[data-todo-item]").first();
    await expect(preview.locator("[data-todo-item]")).toHaveCount(2);
    await expect(row).toHaveCSS("border-bottom-width", "1px");
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(112);
    expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`todo-preview-${width}.png`) });
  });

  test(`agent task lifecycle and recovery at ${width}px${dark ? " dark" : ""}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://localhost/todo-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
      }),
    );
    await page.goto("http://localhost/todo-fixture");
    await page.addScriptTag({ content: script });
    await page.waitForTimeout(100);
    expect(errors, "To-do fixture must mount without a browser exception").toEqual([]);
    const heading = page.getByRole("heading", {
      name: "Your tasks",
      exact: true,
    });
    try {
      await expect(heading).toBeVisible();
    } catch (error) {
      expect(errors, "To-do fixture initialization errors").toEqual([]);
      throw error;
    }
    const headingStyle = await heading.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        size: style.fontSize,
        line: style.lineHeight,
        weight: style.fontWeight,
      };
    });
    expect(headingStyle).toEqual({ size: "20px", line: "23px", weight: "600" });
    await expect(heading).toHaveAttribute("data-ui-role", "agent-title");
    const title = "Review Alex's connection request";
    const checkbox = page.getByRole("checkbox", {
      name: `Mark ${title} as completed`,
    });
    await expect(checkbox).toBeVisible();
    const box = (await checkbox.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Toggle save failure" }).click();
    await checkbox.click();
    await expect(page.getByRole("alert")).toContainText("couldn’t be updated");
    await expect(checkbox).toBeVisible();
    await page.getByRole("button", { name: "Toggle save failure" }).click();
    await checkbox.click();
    await expect(page.getByRole("alert")).toHaveText("Item completed.");
    await page.getByRole("button", { name: "Reopen list" }).click();
    await expect(checkbox).toHaveCount(0);
    await page.getByRole("button", { name: "Completed" }).click();
    await page
      .getByRole("checkbox", { name: `Mark ${title} as not completed` })
      .click();
    await expect(checkbox).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("Item restored.");
    await page.getByRole("button", { name: "Toggle lock" }).click();
    await expect(checkbox).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle lock" }).click();
    await expect(checkbox).toBeVisible();
    await page
      .getByRole("button", { name: "Simulate refresh failure" })
      .click();
    await expect(checkbox).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Some agent tasks" })).toHaveText(
      "Some agent tasks couldn’t refresh. Your other items are still here.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("tasks-refresh-error.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Retry agent tasks" }).click();
    await expect(
      page.getByRole("button", { name: "Retry agent tasks" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("tasks.png"),
      animations: "disabled",
    });
    await page.getByRole("link", { name: `Open ${title}` }).click();
    await expect(
      page.getByRole("region", { name: "Agent workspace" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("empty To-do stays truthful and readable through phone widths and enlargement", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 393, height: 850 });
  await page.route("http://localhost/todo-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto("http://localhost/todo-fixture");
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Toggle agent task" }).click();
  const empty = page.locator('[data-todo-empty-state="true"]');
  await expect(empty.getByRole("heading", { name: "No tasks yet" })).toBeVisible();
  await expect(empty).toContainText("Add an item to get started.");
  expect(await empty.locator('[data-profile-role="name"]').evaluate((node) => getComputedStyle(node).fontSize)).toBe("13px");
  expect(await empty.locator('[data-profile-role="description"]').evaluate((node) => getComputedStyle(node).fontSize)).toBe("12px");

  for (const width of [320, 393, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(empty).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 393, height: 850 });
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  await expect(empty).toBeVisible();
  const add = (await page.getByRole("button", { name: "Add item" }).boundingBox())!;
  expect(add.x).toBeGreaterThanOrEqual(0);
  expect(add.x + add.width).toBeLessThanOrEqual(394);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("todo-empty-200-percent.png"), animations: "disabled" });
});
