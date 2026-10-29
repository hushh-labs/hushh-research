import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";
import { assertThinFocusedCircleType } from "./helpers/circle-type-focus";
import { assertConnectionRemoveDialog } from "./helpers/connection-remove-dialog";

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
  const { transform } = await import("lightningcss");
  css = transform({ filename: "connect-page-grid.css", code: Buffer.from(css), minify: true }).code.toString();
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
  await expect(page.getByRole("tab", { name: "Connections", exact: true })).toHaveAttribute("aria-selected", "true");
  // Circle discovery belongs to Circles, never the Connections panel.
  await expect(page.getByRole("button", { name: /Your Trusted Circle/ })).toBeHidden();
  // Circles now lives in an inactive pager pane, including desktop; it must
  // not expose off-screen controls while the Connections pane is selected.
  await expect(page.locator('[data-connect-surface="circles"]').getByRole("button", { name: /Circle ideas/, includeHidden: true })).toHaveCount(1);
  await expect(page.locator('[data-connect-surface="circles"]').getByRole("button", { name: /Circle ideas/ })).toHaveCount(0);
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
      const workspaceBox = await page.locator("[data-connect-page]").boundingBox();
      expect(workspaceBox).not.toBeNull();
      expect(workspaceBox!.width).toBeLessThanOrEqual(728);
      if (width >= 768) expect(workspaceBox!.width).toBe(728);
      await page.getByRole("tab", { name: /My connections/ }).click();
      const connectionGroup = page.getByTestId("connect-my-connections-group");
      const contactsHeading = connectionGroup.getByRole("heading", { name: "From contacts", exact: true });
      await expect(contactsHeading).toHaveCount(0);
      const contactBadge = connectionGroup.getByLabel("Connected from your contacts");
      await expect(contactBadge).toHaveCount(1);
      const contactIcon = await contactBadge.locator("svg").evaluate((icon) => {
        const box = icon.getBoundingClientRect();
        const reference = document.createElement("span");
        icon.parentElement!.appendChild(reference);
        reference.style.color = "var(--ios-account-accent)";
        const accent = getComputedStyle(reference).color;
        reference.style.color = "var(--ios-account-label)";
        const outline = getComputedStyle(reference).color;
        reference.remove();
        return { width: box.width, height: box.height, accent, outline,
          fill: getComputedStyle(icon.querySelector("g[fill]")!).fill,
          stroke: getComputedStyle(icon.querySelector("g[stroke]")!).stroke };
      });
      expect(contactIcon.width).toBe(12);
      expect(contactIcon.height).toBe(12);
      expect(contactIcon.fill).toBe(contactIcon.accent);
      expect(contactIcon.stroke).toBe(contactIcon.outline);
      expect(contactIcon.fill).not.toBe(contactIcon.stroke);
      await expect(connectionGroup.getByRole("heading", { name: "Other connections", exact: true })).toHaveCount(0);
      const connectionRows = connectionGroup.getByTestId("connect-person-row");
      await expect(connectionRows.filter({ hasText: "Jordan Lee" }).getByLabel("Connected from your contacts")).toHaveCount(1);
      await expect(connectionRows.filter({ hasText: "Alex Chen" }).getByLabel("Connected from your contacts")).toHaveCount(0);
      const badgeGeometry = await contactBadge.evaluate(badge => {
        const badgeBox = badge.getBoundingClientRect();
        const avatarBox = badge.closest('[data-avatar-size="compact"]')!.getBoundingClientRect();
        return { rightOffset: badgeBox.right - avatarBox.right, bottomOffset: badgeBox.bottom - avatarBox.bottom };
      });
      expect(badgeGeometry.rightOffset).toBe(2);
      expect(badgeGeometry.bottomOffset).toBe(2);
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
      expect(rowGeometry.every(row => Math.abs(row.avatarLeft - row.left) < 1 && row.avatarWidth === (width <= 350 ? 32 : 36))).toBe(true);
      expect(rowGeometry.every(row => row.height >= 70)).toBe(true);
      expect(rowGeometry.every(row => row.titleRight <= row.trailingLeft && row.date === "Connected 28 Sep")).toBe(true);
      expect(rowGeometry.every(row => row.actions.every(action => action.width >= 44 && action.height >= 44))).toBe(true);
      // The face sits on the centre line of its name block (one line or two), in
      // both lists, never above it.
      const centred = await page.locator('[data-testid="connect-person-row"], [data-testid="directory-person-row"]').evaluateAll((rows) => rows.filter(row => row.getBoundingClientRect().height > 0).map((row) => {
        const avatar = row.querySelector('[data-avatar-size="compact"]')!.getBoundingClientRect();
        const title = row.querySelector('[data-slot="settings-row-title"]')!.getBoundingClientRect();
        const description = row.querySelector('[data-slot="settings-row-description"]')?.closest("span:not([data-slot])")?.getBoundingClientRect();
        const block = description ? { top: title.top, bottom: description.bottom } : { top: title.top, bottom: title.bottom };
        return Math.abs((avatar.top + avatar.bottom) / 2 - (block.top + block.bottom) / 2);
      }));
      expect(centred.length).toBeGreaterThan(5);
      expect(centred.every((offset) => offset <= 1)).toBe(true);
      await page.getByRole("tab", { name: "Find people", exact: true }).click();
      const cards = page.getByTestId("directory-person-row");
      await expect(cards).toHaveCount(3);
      await expect(cards.first()).not.toContainText("p***0@example.com");
      // Discovery presents names and relationship context, not contact identifiers.
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
      await page.getByRole("tab", { name: /My connections/ }).click();
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
      await page.getByRole("tab", { name: "Find people", exact: true }).click();
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
      await page.getByRole("tab", { name: /My connections/ }).click();
      await assertConnectionRemoveDialog(page, "Alex Chen", width);
      await page.getByRole("tab", { name: "Find people", exact: true }).click();
      await expect(page.locator("#connect-my-connections-panel")).toBeHidden();
      await page.getByRole("tab", { name: /My connections/ }).click();
      await expect(page.locator("#connect-my-connections-panel")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
      const shotDir = process.env.CONNECT_GRID_SHOT_DIR;
      if (shotDir && (width === 393 || width === 1440)) {
        fs.mkdirSync(shotDir, { recursive: true });
        await page.locator("[data-app-scroll-root]").evaluate((node) => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(shotDir, `connect-${width}-${dark ? "dark" : "light"}-top.png`) });
        await page.getByRole("tab", { name: "Find people", exact: true }).click();
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
    await page.getByRole("tab", { name: /My connections/ }).click();
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
    await expect(first).not.toContainText("a***@international-research-department.example.com");
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
    // The v14 action fills its 44px target.
    expect(actionBox!.height).toBeGreaterThanOrEqual(44);
    const pill = await add.locator('[data-slot="connect-row-action-pill"]').boundingBox();
    expect(pill!.height).toBe(44);
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

for (const width of [393, 1440]) {
  for (const dark of [false, true]) {
    test(`Connect search borders stay neutral at rest, hover and focus at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      await open(page, width, dark);
      await settle(page, width);
      const color = dark ? "rgb(245, 245, 247)" : "rgb(29, 29, 31)";
      const check = async (field: ReturnType<Page["getByRole"]>) => {
        await field.scrollIntoViewIfNeeded();
        await expect(field).toHaveValue("");
        await expect(field).toHaveCSS("border-top-width", "1px");
        await expect(field).toHaveCSS("border-top-color", color);
        await field.hover();
        await expect(field).toHaveCSS("border-top-color", color);
        await field.focus();
        await expect(field).toHaveCSS("border-top-color", color);
        await expect(field).toHaveCSS("border-top-width", "1px");
        await expect(field).toHaveCSS("outline-style", "none");
        await expect(field).toHaveCSS("outline-width", "0px");
        await expect(field).toHaveCSS("box-shadow", "none");
        await field.fill("Avery");
        await expect(field).toHaveCSS("border-top-color", color);
        await expect(field).toHaveCSS("outline-width", "0px");
        await field.fill("");
        await field.blur();
        await expect(field).toHaveCSS("border-top-color", color);
      };
      await check(page.getByRole("textbox", { name: "Search people", exact: true }));
      await page.getByRole("tab", { name: /My connections/ }).click();
      await check(page.getByRole("searchbox", { name: "Search my connections by name, email or phone" }));
      await page.evaluate(() => { document.documentElement.dataset.realCircles = "1"; });
      await page.getByRole("tab", { name: "Circles", exact: true }).click();
      await check(page.getByRole("searchbox", { name: "Search your and joined circles" }));
    });
  }
}

// ---- Profile type roles (profile-ui skill) ------------------------------------
for (const width of [320, 393, 1440]) {
  test(`Circle type hierarchy preserves owned and joined circles at ${width}px`, async ({ page }) => {
    await open(page, width, false, undefined, () => {
      document.documentElement.dataset.realCircles = "1";
      document.documentElement.dataset.customCircles = "1";
    });
    await settle(page, width);
    await page.getByRole("tab", { name: "Circles", exact: true }).click();
    const group = page.getByRole("region", { name: "Finance circles", exact: true });
    await expect(group.getByText("Investments", { exact: true })).toBeVisible();
    await expect(group.getByRole("heading", { level: 3 })).toHaveCSS("font-size", "13px");
    const owned = page.getByTestId("connect-circle-group-owned");
    const joined = page.getByTestId("connect-circle-group-joined");
    await expect(owned.getByRole("region", { name: "Family circles", exact: true })).toContainText("Weekend family");
    await expect(owned.getByRole("region", { name: "Friends circles", exact: true })).toContainText("Old classmates");
    await expect(owned.getByText("Project team", { exact: true })).toBeVisible();
    await expect(owned.getByRole("heading", { name: /^Other/ })).toHaveCount(0);
    await expect(joined).toContainText("Shared budget");
    expect(await group.evaluate(node => node.closest('[data-testid="connect-circle-group-owned"]') !== null)).toBe(true);
    expect(await owned.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('[data-testid="connect-circle-group-joined"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(group.getByRole("button", { name: "Options for Investments" })).toHaveCount(0);
    await group.getByRole("button", { name: "Open Investments", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`circle-types-${width}.png`), animations: "disabled" });
    await group.getByRole("button", { name: "Delete Finance type" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Your circles and their members will stay");
    await page.getByRole("button", { name: "Delete type", exact: true }).click();
    await expect(group).toBeHidden();
    await expect(page.getByTestId("connect-circle-group-owned").getByText("Investments", { exact: true })).toBeVisible();
  });
}

// Values are the Profile pane's, read from the running native app on 2026-10-18.
const read = (page: Page, selector: string, index = 0) =>
  page.locator(selector).nth(index).evaluate((node) => {
    const s = getComputedStyle(node);
    return { size: s.fontSize, weight: s.fontWeight, line: s.lineHeight, color: s.color };
  });

for (const width of [320, 393, 768]) {
  test(`Connect uses its own readable roles at ${width}px without changing shell typography`, async ({ page }) => {
    await open(page, width, false);
    await settle(page, width);
    const shell = await read(page, '[data-testid="top-app-bar-breadcrumb-trail"]');
    await page.getByRole("tab", { name: /My connections/ }).click();
    const row = '[data-testid="connect-my-connections-group"] [data-testid="connect-person-row"]';
    expect(await read(page, `${row} [data-slot="settings-row-title"]`)).toMatchObject({ size: "14px", weight: "550", line: "21px" });
    expect(await read(page, `${row} [data-slot="settings-row-description"]`)).toMatchObject({ size: "12px", weight: "400", line: "18px" });
    await page.getByRole("tab", { name: "Find people", exact: true }).click();
    expect(await read(page, '[data-testid="directory-person-row"] [data-slot="settings-row-title"]')).toMatchObject({ size: "14px", weight: "550", line: "21px" });
    await expect(page.getByTestId("connect-directory-group").locator('[data-slot="settings-group-description"]')).toHaveCount(0);
    await page.locator("[data-connect-page]").evaluate(node => {
      const scopedClass = [...node.classList].find(name => name.includes("workspace"));
      if (!scopedClass) throw new Error("Connect typography scope is missing");
      node.classList.remove(scopedClass);
    });
    expect(await read(page, '[data-testid="directory-person-row"] [data-slot="settings-row-title"]')).not.toMatchObject({ size: "14px", line: "21px" });
    expect(await read(page, '[data-testid="top-app-bar-breadcrumb-trail"]')).toEqual(shell);
  });

  test(`a drag that starts inside My connections scrolls its full roster at ${width}px`, async ({ page }) => {
    await open(page, width, false, undefined, () => {
      document.documentElement.dataset.connections = "24";
      document.documentElement.dataset.bottomChrome = "1";
    });
    await expect(page.getByTestId("connect-my-connections-group").getByTestId("connect-person-row")).toHaveCount(24, { timeout: 30_000 });
    await expect(page.getByTestId("directory-person-row")).toHaveCount(3);
    await page.getByRole("tab", { name: /My connections/ }).click();
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
    // The active pager measures its height in ResizeObserver + rAF after the
    // rows mount. Wait for that layout commit before testing wheel propagation.
    await expect.poll(() => root.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(600);
    // A real gesture can begin after the page has already moved.
    await root.evaluate((node) => { node.scrollTop = 12; });
    await expect.poll(() => root.evaluate((node) => node.scrollTop)).toBe(12);
    const maxScroll = await root.evaluate((node) => node.scrollHeight - node.clientHeight);
    // The gesture carries all the way to the end of the page, through People.
    await wheelFromRow();
    await expect.poll(() => root.evaluate((node) =>
      node.scrollHeight - node.clientHeight - node.scrollTop,
    )).toBeLessThanOrEqual(2);

    // The last result and its action stay clear of the bottom chrome.
    await root.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect.poll(async () => {
      const last = await rows.last().boundingBox();
      const chrome = await page.locator("[data-fixture-bottom-shell]").boundingBox();
      return Boolean(last && chrome && last.y + last.height <= chrome.y);
    }).toBe(true);

    // The 44px action targets reach past the column, so the list's shell must not
    // be a clipped box: a clipped one can be scrolled sideways (a click that
    // scrolls the target into view moved every row 10px left and cut the avatars).
    const shell = page.locator('[data-testid="connect-my-connections-group"] [data-slot="settings-group-shell"]');
    expect(await shell.evaluate((node) => getComputedStyle(node).overflowX)).toBe("visible");
    await page.getByRole("button", { name: /^Options for/ }).last().focus();
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
    const fits: boolean[] = [];
    for (const view of [/My connections/, /^Find people$/]) {
      await page.getByRole("tab", { name: view }).click();
      const rows = page.locator(view.source.includes("My connections") ? '[data-testid="connect-person-row"]' : '[data-testid="directory-person-row"]');
      fits.push(...await rows.evaluateAll((nodes, viewport) => nodes.map((row) => {
      const box = row.getBoundingClientRect();
      const text = row.querySelector<HTMLElement>('[data-slot="settings-row-title"]')!.getBoundingClientRect();
      const trailing = row.querySelector('[data-slot="settings-row-trailing"]')!.getBoundingClientRect();
      const reach = [...row.querySelectorAll<HTMLElement>('[data-slot="settings-row-trailing"] button')]
        .every((button) => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= viewport && r.width >= 44 && r.height >= 44; });
      return (text.right <= trailing.left + 1 || text.bottom <= trailing.top + 1) && box.right <= viewport + 1 && reach;
    }), width));
    }
    expect(fits.length).toBeGreaterThan(8);
    expect(fits.every(Boolean)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

for (const width of [393, 1440]) {
  for (const dark of [false, true]) {
    test(`Connection tab count is compact and round at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      await open(page, width, dark);
      await settle(page, width);
      const tabs = page.getByRole("tablist", { name: "Connection views" });
      const mine = tabs.getByRole("tab", { name: /My connections/ });
      const count = mine.locator("span").filter({ hasText: /^\d+$/ }).last();
      // Check the inactive state too: the old undefined fill token was
      // transparent, and an active-only check could never catch that defect.
      await expect(mine).toHaveAttribute("aria-selected", "false");
      const expected = dark ? "rgba(255, 255, 255, 0.06)" : "rgba(120, 120, 128, 0.16)";
      await expect(count).toHaveCSS("background-color", expected);
      const inactiveValue = await count.textContent();
      const centers = await mine.evaluate(node => {
        const content = node.firstElementChild!;
        const label = content.children[0].getBoundingClientRect();
        const badge = content.children[1].getBoundingClientRect();
        return Math.abs(label.y + label.height / 2 - badge.y - badge.height / 2);
      });
      expect(centers).toBeLessThanOrEqual(0.5);
      await mine.click();
      await expect(count).toHaveText(inactiveValue!);
      await expect(count).not.toHaveCSS("background-color", expected);
      await expect(count).toBeVisible();
      await expect(count).toHaveCSS("border-radius", "999px");
      await expect(count).toHaveCSS("font-size", "10px");
      await expect(count).toHaveCSS("height", "17px");
      await expect(tabs).toHaveCSS("border-bottom-width", "0px");
      await page.screenshot({ path: test.info().outputPath(`connections-${width}-${dark ? "dark" : "light"}.png`), animations: "disabled" });
    });
  }
}

for (const width of [393, 1440]) {
  for (const presentation of ["page", "modal"]) {
    test(`Create Circle reuses Connect typography in ${presentation} at ${width}px`, async ({ page }) => {
      const prepare = presentation === "modal" ? () => {
        document.documentElement.dataset.realCircles = "1";
        document.documentElement.dataset.customCircles = "1";
        document.documentElement.dataset.initialQuery = "?tab=circles&action=create-circle";
        document.documentElement.dataset.createModal = "1";
      } : () => {
        document.documentElement.dataset.realCircles = "1";
        document.documentElement.dataset.customCircles = "1";
        document.documentElement.dataset.initialQuery = "?tab=circles&action=create-circle";
      };
      await open(page, width, presentation === "modal", undefined, prepare);
      if (presentation === "modal") await expect(page.getByRole("dialog", { name: "Create a Circle" })).toBeVisible();
      const form = page.getByTestId("one-location-create-circle-flow");
      const name = form.getByRole("textbox", { name: "Circle name" });
      await expect(name).toBeVisible();
      await expect(name).toHaveCSS("font-size", "14px");
      await expect(name).toHaveCSS("line-height", "22px");
      await expect(form.getByText("Circle name", { exact: true })).toHaveCSS("font-size", "15px");
      await expect(form.getByText("Circle name", { exact: true })).toHaveCSS("font-weight", "550");
      await expect(form.getByRole("radio", { name: "Finance", exact: true })).toBeVisible();
      await form.getByRole("radio", { name: "Other", exact: true }).click();
      const type = form.getByRole("textbox", { name: "Type name (optional)" });
      await assertThinFocusedCircleType(type);
      await expect(form.getByText("Type name (optional)", { exact: true })).toHaveCSS("font-size", "15px");
      const error = form.getByText("Enter a Circle name.", { exact: true });
      await expect(error).toHaveCSS("font-size", "12px");
      await expect(error).toHaveCSS("line-height", "18px");
      await expect(error).toHaveCSS("color", presentation === "modal" ? "rgb(255, 69, 58)" : "rgb(255, 59, 48)");
      await expect(form.getByText("Reuse this type for other circles. You can keep up to 3 custom types.")).toHaveCSS("font-size", "12px");
      await page.screenshot({ path: test.info().outputPath(`create-circle-${presentation}-${width}.png`), animations: "disabled" });
    });
  }
  test(`Connection icons halve their visible gap at ${width}px without shrinking targets`, async ({ page }) => {
    await open(page, width, false);
    await settle(page, width);
    await page.getByRole("tab", { name: /My connections/ }).click();
    const row = page.getByTestId("connect-person-row").filter({ has: page.getByRole("button", { name: "Message Jordan Lee", exact: true }) });
    const spacing = await row.evaluate(node => {
      const message = node.querySelector('button[aria-label="Message Jordan Lee"]')!;
      const options = node.querySelector('button[aria-label="Options for Jordan Lee"]')!;
      const first = message.querySelector("svg")!;
      const second = options.querySelector("svg")!;
      const gap = () => second.getBoundingClientRect().left - first.getBoundingClientRect().right;
      const tightened = gap();
      first.classList.remove("translate-x-1.5");
      second.classList.remove("-translate-x-1.5");
      const previous = gap();
      first.classList.add("translate-x-1.5");
      second.classList.add("-translate-x-1.5");
      const a = message.getBoundingClientRect(), b = options.getBoundingClientRect();
      return { tightened, previous, targets: [a.width, a.height, b.width, b.height], overlap: a.right > b.left };
    });
    expect(spacing.tightened / spacing.previous).toBeCloseTo(0.5, 1);
    expect(spacing.targets).toEqual([44, 44, 44, 44]);
    expect(spacing.overlap).toBe(false);
  });
  for (const joined of [false, true]) {
    test(`Join with code stays transparent with joined=${joined} at ${width}px`, async ({ page }) => {
      const prepare = joined ? () => {
        document.documentElement.dataset.realCircles = "1";
        document.documentElement.dataset.customCircles = "1";
        document.documentElement.dataset.initialQuery = "?tab=circles";
      } : () => {
        document.documentElement.dataset.realCircles = "1";
        document.documentElement.dataset.initialQuery = "?tab=circles";
      };
      await open(page, width, false, undefined, prepare);
      if (joined) await expect(page.getByTestId("connect-circle-group-joined")).toBeVisible();
      else await expect(page.getByText("Make a circle", { exact: true })).toBeVisible();
      const join = page.getByTestId("connect-circle-join");
      await join.scrollIntoViewIfNeeded();
      await expect(join).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await join.hover();
      await expect(join).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(join.locator("[data-ripple-mode]")).toHaveCount(0);
      const gap = await join.evaluate(node => {
        const icon = node.querySelector("svg")!.getBoundingClientRect();
        const text = node.querySelector("span > span")!.getBoundingClientRect();
        return text.left - icon.right;
      });
      expect(gap).toBeCloseTo(6, 1);
    });
  }
}
