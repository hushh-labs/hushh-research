import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/** Production Connect page against synthetic identity/network boundaries. */

const WIDTHS = [320, 375, 393, 430, 640, 768, 1440] as const;

const STUBBED = [
  "next/navigation",
  "@/hooks/use-auth",
  "@/lib/vault/vault-context",
  "@/lib/firebase/config",
  "@/lib/services/auth-service",
  "@/lib/services/direct-messages-service",
  "@/lib/services/connections-service",
  "@/lib/services/cache-service",
  "@/lib/cache/cache-sync-service",
  "@/lib/one-location/service",
  "@/lib/contacts/use-contact-sync",
  "@/lib/kai/actions/voice-surface-metadata",
  "@/lib/agent/local-onboarding-actions",
  "@/lib/connections/use-outgoing-request-resolution-watch",
  "@/lib/connections/connection-graph-events",
  "@/components/connect/circles/connect-circles-tab",
  "@/components/connect/nearby-directories",
  "@/components/one-location/contact-sync-results-sheet",
  "@/components/connections/contact-discoverability-consent-dialog",
  "@/components/one-location/onboarding/location-onboarding-interaction-surface",
];

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-page-grid-"));
  const boundaries = path.join(root, "e2e/fixtures/connect-page-boundaries.tsx");
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
        },
      },
    ],
    resolve: {
      alias: [
        ...STUBBED.map((find) => ({ find, replacement: boundaries })),
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify("https://one.example"),
      "process.env": "{}",
    },
    build: {
      copyPublicDir: false,
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/connect-page.tsx"),
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
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css =
    stripAppFontFaces(compiler.build([...candidates])) +
    productFontStyle() +
    fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
      .join("\n");
});

type Timings = { connectionsMs: number; circlesMs: number; directoryMs: number };

/** Loads the page. `beforeScript` runs in the document before React does. */
async function open(
  page: Page,
  width: number,
  dark: boolean,
  timings: Timings = { connectionsMs: 0, circlesMs: 0, directoryMs: 0 },
  beforeScript?: () => void,
) {
  await page.setViewportSize({ width, height: 900 });
  const url = "http://localhost/connect-page-grid";
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${dark ? "dark" : ""}" data-connections-ms="${timings.connectionsMs}" data-circles-ms="${timings.circlesMs}" data-directory-ms="${timings.directoryMs}"><head><title>Connect layout fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto(url);
  await awaitProductFont(page);
  if (beforeScript) await page.evaluate(beforeScript);
  await page.addScriptTag({ content: script });
}

async function settle(page: Page, _width: number) {
  const group = page.getByTestId("connect-my-connections-group");
  // The page bundle is large; its first commit can take a few seconds under
  // parallel workers before the timed network even starts.
  await expect(group.locator("[data-voice-label]")).toHaveCount(6, { timeout: 30_000 });
  await expect(page.getByTestId("connect-directory-group").getByText("Avery Stone")).toBeVisible();
  // Circles now lives in an inactive pager pane, including desktop; it must
  // not expose off-screen controls while the Connections pane is selected.
  await expect(page.locator('[data-connect-surface="circles"]').getByText("Your Trusted Circle", { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-connect-surface="circles"]').locator('..')).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                // The spinner is a spinner.
                !(animation as CSSAnimation).animationName?.includes("spin"),
            ).length,
      ),
    )
    .toBe(0);
}

for (const dark of [false, true]) {
  for (const width of WIDTHS) {
    test(`Stitch Connect cards preserve actions at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, width, dark);
      await settle(page, width);
      const connectionGroup = page.getByTestId("connect-my-connections-group");
      await expect(connectionGroup.getByRole("heading", { name: "From contacts", exact: true })).toHaveCount(1);
      await expect(connectionGroup.getByRole("heading", { name: "Other connections", exact: true })).toHaveCount(1);
      await expect(connectionGroup.getByLabel("Connected from your contacts")).toHaveCount(0);
      await expect(page.getByTestId("connection-source-contacts").getByText("Jordan Lee", { exact: true })).toHaveCount(1);
      await expect(page.getByTestId("connection-source-other").getByText("Alex Chen", { exact: true })).toHaveCount(1);
      const rowGeometry = await connectionGroup.locator('[data-testid="connect-person-row"]').evaluateAll(rows => rows.map(row => {
        const rect = row.getBoundingClientRect();
        const avatar = row.querySelector('[data-avatar-size="compact"]')!.getBoundingClientRect();
        const title = row.querySelector('[data-slot="settings-row-title"]')!.getBoundingClientRect();
        const description = row.querySelector('[data-slot="settings-row-description"]')!;
        const trailing = row.querySelector('[data-slot="settings-row-trailing"]')!.getBoundingClientRect();
        return { height: rect.height, left: rect.left, right: rect.right, avatarLeft: avatar.left, avatarWidth: avatar.width, titleRight: title.right, trailingLeft: trailing.left, date: description.textContent,
          actions: [...row.querySelectorAll('[data-slot="settings-row-trailing"] button')].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
        };
      }));
      // Feed's ordinary-row anatomy: a 26px face centred in a 30px well, so the
      // face starts 2px in from the row edge, and the row is compact.
      expect(rowGeometry.every(row => Math.abs(row.avatarLeft - row.left - 2) < 1 && row.avatarWidth === 26)).toBe(true);
      expect(rowGeometry.every(row => row.height <= 60)).toBe(true);
      expect(rowGeometry.every(row => row.titleRight <= row.trailingLeft && row.date === "Connected 28 Sep")).toBe(true);
      expect(rowGeometry.every(row => row.actions.every(action => action.width >= 44 && action.height >= 44))).toBe(true);
      // The face sits on the centre line of its name block (one line or two), in
      // both lists, never above it.
      const centred = await page.locator('[data-testid="connect-person-row"], [data-testid="directory-person-row"]').evaluateAll((rows) => rows.map((row) => {
        const avatar = row.querySelector('[data-avatar-size="compact"]')!.getBoundingClientRect();
        const title = row.querySelector('[data-slot="settings-row-title"]')!.getBoundingClientRect();
        const description = row.querySelector('[data-slot="settings-row-description"]')?.closest("span:not([data-slot])")?.getBoundingClientRect();
        const block = description ? { top: title.top, bottom: description.bottom } : { top: title.top, bottom: title.bottom };
        return Math.abs((avatar.top + avatar.bottom) / 2 - (block.top + block.bottom) / 2);
      }));
      expect(centred.length).toBeGreaterThan(5);
      expect(centred.every((offset) => offset <= 1)).toBe(true);
      const cards = page.getByTestId("directory-person-row");
      await expect(cards).toHaveCount(3);
      await expect(cards.first()).toContainText("p***0@example.com");
      // An email or no line: a masked phone is never shown on a directory row.
      await expect(cards.first()).not.toContainText("98******10");
      await expect(page.getByTestId("directory-person-masked-phone")).toHaveCount(0);
      await expect(cards.first().getByText("Alex Chen", { exact: true })).toHaveCount(0);
      await expect(cards.first()).toContainText("2 mutual connections");
      const mutual = cards.first().getByRole("button", { name: "Open mutual connection Alex Chen's profile" });
      await mutual.click();
      await expect(page.locator("body")).toHaveAttribute("data-last-navigation", /^\/people\/person_alex\?/);
      await expect(cards.nth(1).getByTestId("mutual-connection")).toHaveCount(0);
      // Circle creation moved to its named flow; Connect cards no longer own
      // the retired discovery-card dialog (also asserted by the page unit contract).
      await expect(page.getByRole("button", { name: "Create your own circle" })).toHaveCount(0);
      const messageButtons = page.getByRole("button", { name: /^Message / });
      await expect(messageButtons).toHaveCount(6);
      const alexMessage = page.getByRole("button", { name: "Message Alex Chen", exact: true });
      await expect(alexMessage).toBeEnabled();
      await alexMessage.click();
      await expect(page.locator("body")).toHaveAttribute(
        "data-last-navigation",
        "/one/messages?token=dm1.fixture",
      );
      await expect(page.locator("body")).toHaveAttribute("data-message-recipient", "person_0");
      const geometry = await cards.evaluateAll((nodes) => nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, width: r.width };
      }));
      expect(geometry.every((r) => r.left >= 0 && r.right <= width)).toBe(true);
      expect(geometry.every((r) => r.left >= 0 && r.right <= width)).toBe(true);
      // One column at every width, rows no taller than a compact person row plus
      // its mutual-connections line.
      expect(geometry[1].top).toBeGreaterThan(geometry[0].top);
      expect(geometry.every((r) => Math.abs(r.width - geometry[0].width) <= 1)).toBe(true);
      await page.getByRole("button", { name: /Remove connection with Alex Chen/ }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThan(2);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByTestId("connect-my-connections-toggle").click();
      await expect(page.locator("#connect-my-connections-panel")).toBeHidden();
      await page.getByTestId("connect-my-connections-toggle").click();
      await expect(page.locator("#connect-my-connections-panel")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
      const shotDir = process.env.CONNECT_GRID_SHOT_DIR;
      if (shotDir && (width === 393 || width === 1440)) {
        fs.mkdirSync(shotDir, { recursive: true });
        await page.locator("[data-app-scroll-root]").evaluate((node) => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(shotDir, `connect-${width}-${dark ? "dark" : "light"}-top.png`) });
        await cards.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(shotDir, `connect-${width}-${dark ? "dark" : "light"}-people.png`) });
      }
    });
  }
}

for (const width of [320, 1440]) {
  test(`keeps a long connection name clear of actions at ${width}px`, async ({ page }) => {
    await open(page, width, false, undefined, () => { document.documentElement.dataset.longConnectionName = "1"; });
    await settle(page, width);
    const row = page.getByTestId("connect-my-connections-group").getByTestId("connect-person-row").filter({ hasText: "24E2100221 Mayank Featherstonehaugh-Rajendran" });
    await expect(row).toHaveCount(1);
    // The name wraps in its column and the row grows; nothing is cut off or
    // pushed under the actions.
    const fit = await row.evaluate(node => {
      const title = node.querySelector<HTMLElement>('[data-slot="settings-row-title"]')!;
      const trailing = node.querySelector('[data-slot="settings-row-trailing"]')!;
      const style = getComputedStyle(title);
      return title.scrollWidth <= title.clientWidth + 1 && title.getBoundingClientRect().right <= trailing.getBoundingClientRect().left && style.overflowWrap === 'anywhere' && style.textOverflow !== 'ellipsis' && node.getBoundingClientRect().height >= title.getBoundingClientRect().height;
    });
    expect(fit).toBe(true);
    await expect(row.getByRole("button", { name: /^Message / })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

for (const width of [320, 393, 1440]) {
  test(`stacks an empty search and keeps its invite above bottom chrome at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await open(page, width, false, undefined, () => {
      document.documentElement.dataset.emptyDirectoryOnQuery = "1";
      document.documentElement.dataset.bottomChrome = "1";
    });
    await settle(page, width);
    await expect(page).toHaveURL("http://localhost/connect-page-grid");
    await expect(page).toHaveTitle("Connect layout fixture");
    await expect(page.locator("nextjs-portal, vite-error-overlay")).toHaveCount(0);

    const query = "avery.with.a.very.long.identity@international-research.example.com";
    const search = page.getByRole("textbox", { name: "Search people" });
    await search.fill(query);
    await search.press("Enter");
    const group = page.getByTestId("connect-directory-group");
    const empty = group.getByTestId("settings-row").filter({ hasText: `No one matches "${query}"` });
    const invite = group.getByTestId("connect-invite-to-one");
    await expect(empty).toHaveCount(1);
    await expect(invite).toBeVisible();
    await expect(group.getByTestId("directory-person-row")).toHaveCount(0);
    // Search focus can still be smoothly scrolling the page. Read all viewport
    // boxes in one turn so scrolling cannot move between measurements.
    const { emptyBox, inviteBox, groupBox } = await group.evaluate((node, label) => {
      const row = [...node.querySelectorAll('[data-testid="settings-row"]')]
        .find((candidate) => candidate.textContent?.includes(label));
      const box = (element: Element | null | undefined) => {
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        emptyBox: box(row),
        inviteBox: box(node.querySelector('[data-testid="connect-invite-to-one"]')),
        groupBox: box(node),
      };
    }, `No one matches "${query}"`);
    expect(emptyBox).not.toBeNull();
    expect(inviteBox).not.toBeNull();
    expect(groupBox).not.toBeNull();
    expect(inviteBox!.y).toBeGreaterThanOrEqual(emptyBox!.y + emptyBox!.height);
    expect(Math.abs(emptyBox!.width - groupBox!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(inviteBox!.width - groupBox!.width)).toBeLessThanOrEqual(2);
    expect(await empty.locator('[data-slot="settings-row-title"]').evaluate(node => {
      const style = getComputedStyle(node);
      return node.scrollWidth <= node.clientWidth + 1 && style.overflowWrap === "anywhere";
    })).toBe(true);

    await page.locator("[data-app-scroll-root]").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(async () => {
      const last = await invite.boundingBox();
      const chrome = await page.locator("[data-fixture-bottom-shell]").boundingBox();
      return Boolean(last && chrome && last.y + last.height <= chrome.y);
    }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const shotDir = process.env.CONNECT_GRID_SHOT_DIR;
    if (shotDir && width === 393) {
      fs.mkdirSync(shotDir, { recursive: true });
      await page.screenshot({ path: path.join(shotDir, `connect-393-empty-search-${testInfo.project.name}.png`) });
    }
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect(group.getByTestId("directory-person-row")).toHaveCount(3);
    await expect(empty).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test(`wraps a long directory identity beside its action at ${width}px`, async ({ page }, testInfo) => {
    await open(page, width, false, undefined, () => {
      document.documentElement.dataset.longDirectoryIdentity = "1";
    });
    const cards = page.getByTestId("directory-person-row");
    await expect(cards).toHaveCount(3);
    const first = cards.first();
    await expect(first).toContainText("Avery Featherstonehaugh-Rajendran");
    await expect(first).toContainText("a***@international-research-department.example.com");
    await expect(first).not.toContainText("98******10");
    const groupBox = await page.getByTestId("connect-directory-group").boundingBox();
    const cardBox = await first.boundingBox();
    expect(groupBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(Math.abs(cardBox!.width - groupBox!.width)).toBeLessThanOrEqual(2);
    expect(await first.evaluate(node => [...node.querySelectorAll<HTMLElement>("span, button")]
      .every(child => child.scrollWidth <= child.clientWidth + 1))).toBe(true);
    const add = first.getByRole("button", { name: "Connect", exact: true });
    await expect(add).toBeEnabled();
    const actionBox = await add.boundingBox();
    // The button is a 44px target around a compact 32px pill.
    expect(actionBox!.height).toBeGreaterThanOrEqual(44);
    const pill = await add.locator("span").first().boundingBox();
    expect(pill!.height).toBeLessThanOrEqual(34);
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    // The identity keeps its own column: the action never sits on the text.
    const textBox = await first.locator('[data-slot="settings-row-title"]').boundingBox();
    expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(actionBox!.x + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const shotDir = process.env.CONNECT_GRID_SHOT_DIR;
    if (shotDir && width === 393) {
      fs.mkdirSync(shotDir, { recursive: true });
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(shotDir, `connect-393-long-identity-${testInfo.project.name}.png`) });
    }
  });
}

// ---- Profile type roles (profile-ui skill) ------------------------------------
// Values are the Profile pane's, read from the running native app on 2026-10-18.
const read = (page: Page, selector: string, index = 0) =>
  page.locator(selector).nth(index).evaluate((node) => {
    const s = getComputedStyle(node);
    return { size: s.fontSize, weight: s.fontWeight, line: s.lineHeight, color: s.color };
  });

for (const width of [320, 393, 768]) {
  test(`Connect takes the Profile type roles at ${width}px, and only while it is the page`, async ({ page }) => {
    await open(page, width, false);
    await settle(page, width);
    const px = (value: string) => Number.parseFloat(value);

    // Surface header: the shell title.
    expect(await read(page, '[data-testid="top-app-bar-breadcrumb-trail"]')).toMatchObject({ size: "20px", weight: "600", line: "23px" });
    // Primary label: both tabs, selected or not.
    for (const index of [0, 1]) {
      expect(await read(page, '[data-ui-role="agent-tab-label"]', index)).toMatchObject({ size: "13px", weight: "550", line: "15.6px" });
    }
    // The title of a list outranks the heading nested under it.
    const parent = await read(page, ".connect-section-control-label", 0);
    const child = await read(page, '[data-testid="connect-my-connections-group"] [data-slot="settings-group-heading"]', 0);
    expect(parent).toMatchObject({ size: "13px", weight: "550" });
    expect(child).toMatchObject({ size: "10px", weight: "600", line: "14px" });
    expect(px(parent.size)).toBeGreaterThanOrEqual(px(child.size));
    // Name and its secondary line.
    const row = '[data-testid="connect-my-connections-group"] [data-testid="connect-person-row"]';
    expect(await read(page, `${row} [data-slot="settings-row-title"]`)).toMatchObject({ size: "13px", weight: "400", line: "15.86px" });
    expect(await read(page, `${row} [data-slot="settings-row-description"]`)).toMatchObject({ size: "12px", weight: "400", line: "15.6px" });
    // Directory: the helper line, an email line and the action label.
    expect(await read(page, '[data-testid="connect-directory-group"] [data-slot="settings-group-description"]')).toMatchObject({ size: "12px", line: "15.6px" });
    expect(await read(page, '[data-testid="directory-person-row"] [data-slot="settings-row-description"]')).toMatchObject({ size: "12px" });
    expect(await read(page, '[data-testid="directory-person-row"] [data-profile-role="action"]')).toMatchObject({ size: "12px", weight: "500", line: "15.6px" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // Negative control: take the page out of the scale and the same elements fall
    // back to the app-wide roles, so the rules are scoped, not global.
    await page.locator("[data-connect-page]").evaluate((node) => node.removeAttribute("data-profile-type-scale"));
    expect(await read(page, '[data-testid="top-app-bar-breadcrumb-trail"]')).not.toMatchObject({ size: "20px" });
    expect(await read(page, `${row} [data-slot="settings-row-title"]`)).not.toMatchObject({ size: "13px" });
  });

  test(`a drag that starts inside My connections reaches People at ${width}px`, async ({ page }) => {
    await open(page, width, false, undefined, () => {
      document.documentElement.dataset.connections = "14";
      document.documentElement.dataset.bottomChrome = "1";
    });
    await expect(page.getByTestId("connect-my-connections-group").getByTestId("connect-person-row")).toHaveCount(14, { timeout: 30_000 });
    await expect(page.getByTestId("directory-person-row")).toHaveCount(3);
    const root = page.locator("[data-app-scroll-root]");
    const list = page.locator("#connect-my-connections-panel");
    const rows = page.getByTestId("connect-my-connections-group").getByTestId("connect-person-row");

    // The list is part of the page: not a scroller, not a scroll trap.
    expect(await list.evaluate((node) => {
      const s = getComputedStyle(node);
      return { overflowY: s.overflowY, overscroll: s.overscrollBehaviorY, own: node.scrollHeight - node.clientHeight };
    })).toEqual({ overflowY: "visible", overscroll: "auto", own: 0 });

    const wheelFromRow = async () => {
      const box = await rows.nth(3).boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      const before = await root.evaluate((node) => node.scrollTop);
      for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 700);
      await page.waitForTimeout(150);
      return (await root.evaluate((node) => node.scrollTop)) - before;
    };
    const maxScroll = await root.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(maxScroll).toBeGreaterThan(600);
    // The gesture carries all the way to the end of the page, through People.
    expect(await wheelFromRow()).toBeGreaterThanOrEqual(maxScroll - 2);

    // The last result and its action stay clear of the bottom chrome.
    await root.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect.poll(async () => {
      const last = await page.getByTestId("directory-person-row").last().boundingBox();
      const chrome = await page.locator("[data-fixture-bottom-shell]").boundingBox();
      return Boolean(last && chrome && last.y + last.height <= chrome.y);
    }).toBe(true);

    // The 44px action targets reach past the column, so the list's shell must not
    // be a clipped box: a clipped one can be scrolled sideways (a click that
    // scrolls the target into view moved every row 10px left and cut the avatars).
    const shell = page.locator('[data-testid="connect-my-connections-group"] [data-slot="settings-group-shell"]');
    expect(await shell.evaluate((node) => getComputedStyle(node).overflowX)).toBe("visible");
    await page.getByRole("button", { name: /^Remove connection with/ }).last().focus();
    expect(await shell.evaluate((node) => node.scrollLeft)).toBe(0);

    // Negative control: the old markup (a capped list that contains its
    // overscroll) swallows the same gesture, so the assertion above can fail.
    await root.evaluate((node) => { node.scrollTop = 0; });
    await list.evaluate((node) => node.classList.add("max-h-[min(60dvh,28rem)]", "overflow-y-auto", "overscroll-contain"));
    expect(await wheelFromRow()).toBeLessThan(maxScroll / 2);
  });
}

// 200% enlargement of the narrowest and the standard phone is a 160px and a 196px
// layout viewport. Long names wrap and rows grow; nothing is clipped, nothing
// slides under an action, and the page does not scroll sideways.
for (const width of [160, 196]) {
  test(`keeps long names and actions readable at 200% enlargement (${width}px layout width)`, async ({ page }) => {
    await open(page, width, false, undefined, () => {
      document.documentElement.dataset.longConnectionName = "1";
      document.documentElement.dataset.longDirectoryIdentity = "1";
    });
    await expect(page.getByTestId("connect-my-connections-group").getByTestId("connect-person-row")).toHaveCount(6, { timeout: 30_000 });
    await expect(page.getByTestId("directory-person-row")).toHaveCount(3);
    const rows = page.locator('[data-testid="connect-person-row"], [data-testid="directory-person-row"]');
    const fits = await rows.evaluateAll((nodes, viewport) => nodes.map((row) => {
      const box = row.getBoundingClientRect();
      const text = row.querySelector<HTMLElement>('[data-slot="settings-row-title"]')!.getBoundingClientRect();
      const trailing = row.querySelector('[data-slot="settings-row-trailing"]')!.getBoundingClientRect();
      const reach = [...row.querySelectorAll<HTMLElement>('[data-slot="settings-row-trailing"] button')]
        .every((button) => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= viewport && r.width >= 44 && r.height >= 44; });
      return text.right <= trailing.left + 1 && box.right <= viewport + 1 && reach;
    }), width);
    expect(fits.length).toBeGreaterThan(8);
    expect(fits.every(Boolean)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
