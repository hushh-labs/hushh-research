import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * One clickable settings row, one interactive surface.
 *
 * The founder reported a "double box" on the person profile's "Available to
 * request" list: pressing "Financial 13 [ ] >" lit up a rectangle behind the
 * title only, inset inside the row, which itself sat inside the grouped card.
 * The row's hit target was that inner rectangle too: the count, the empty
 * space and the chevron did nothing.
 *
 * The cause was the SettingsRow primitive. A row whose trailing slot held a
 * control (a checkbox, a switch, a button) was "split": an inner <button>
 * wrapped the title alone, carried its own padding inside the grid's padding,
 * its own ripple and its own focus ring, while the trailing controls and the
 * chevron sat beside it as siblings. Every consumer with a trailing control
 * inherited it.
 *
 * This spec measures the rendered rows of the real consumers. LegacySplitRow in
 * the fixture is a frozen copy of the old markup and must FAIL the same
 * contract, so the assertions are shown to detect the defect they guard.
 */

let script: string;
let css: string;

const CONTRACT_SOURCE = `
window.__rowContract = function (row) {
  const violations = [];
  const box = row.getBoundingClientRect();
  const same = (r) =>
    Math.abs(r.left - box.left) <= 1 && Math.abs(r.right - box.right) <= 1 &&
    Math.abs(r.top - box.top) <= 1 && Math.abs(r.bottom - box.bottom) <= 1;
  const describe = (r) => [r.left, r.top, r.width, r.height].map((n) => Math.round(n)).join(",");
  const primaries = [...row.querySelectorAll('button,a[href],[role=button],[tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.closest('[data-slot="settings-row-trailing"]'))
    .filter((el) => !el.matches('input,select,textarea,[role=switch],[role=checkbox],[role=radio]'));
  if (primaries.length !== 1) violations.push("interactive surfaces=" + primaries.length);
  for (const el of primaries) {
    const r = el.getBoundingClientRect();
    if (!same(r)) violations.push("surface " + describe(r) + " != row " + describe(box));
    for (const host of el.querySelectorAll(".morphy-ripple-host")) {
      const h = host.getBoundingClientRect();
      if (!same(h)) violations.push("press surface " + describe(h) + " != row " + describe(box));
    }
  }
  return violations;
};
window.__paintedBackgrounds = function (row) {
  return [row, ...row.querySelectorAll("*")].map((el) => getComputedStyle(el).backgroundColor);
};
window.__changedBackgroundBoxes = function (row, before) {
  const all = [row, ...row.querySelectorAll("*")];
  const box = row.getBoundingClientRect();
  return all.flatMap((el, index) => {
    const now = getComputedStyle(el).backgroundColor;
    if (now === before[index]) return [];
    const r = el.getBoundingClientRect();
    return [{ full: Math.abs(r.left - box.left) <= 1 && Math.abs(r.right - box.right) <= 1 &&
      Math.abs(r.top - box.top) <= 1 && Math.abs(r.bottom - box.bottom) <= 1,
      tag: el.tagName, width: Math.round(r.width), rowWidth: Math.round(box.width) }];
  });
};
`;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-row-surface-"));
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
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/settings-row-surface.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function openFixture(
  page: Page,
  width: number,
  theme: "light" | "dark" = "light",
  extraCss = "",
) {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost/settings-row-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${extraCss}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto("http://localhost/settings-row-fixture");
  await page.addScriptTag({ content: CONTRACT_SOURCE });
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByTestId("consumer-legacy")).toBeVisible();
  return errors;
}

const events = (page: Page) =>
  page.evaluate(() => [...window.__rowEvents]);
const clearEvents = (page: Page) =>
  page.evaluate(() => {
    window.__rowEvents.length = 0;
  });
const contract = (row: Locator) =>
  row.evaluate((node) =>
    (window as unknown as { __rowContract: (el: Element) => string[] }).__rowContract(node),
  );

/** Every clickable row the four consumers render. */
const CLICKABLE_ROWS = [
  '[data-row-layout][data-testid^="person-profile-scope-group-"]',
  '[data-testid="profile-row-personal"]',
  '[data-testid="profile-row-notifications"]',
  '[data-testid="consent-row-a"]',
  '[data-testid="consent-row-history"]',
];

async function clickAt(page: Page, row: Locator, where: "leading" | "trailing" | "title" | "chevron") {
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  // Mid-height: a first or last row's corner is rounded and clipped by the
  // group, and WebKit hit-tests that clip, so a corner point is not the row.
  if (where === "leading") return page.mouse.click(box.x + 4, box.y + box.height / 2);
  if (where === "trailing") return page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
  const target = row.locator(
    where === "title" ? '[data-slot="settings-row-title"]' : '[data-slot="settings-row-chevron"]',
  );
  const t = (await target.first().boundingBox())!;
  return page.mouse.click(t.x + Math.min(t.width / 2, 12), t.y + t.height / 2);
}

for (const width of [393, 1440]) {
  test(`a clickable settings row is one full-width surface at ${width}px`, async ({ page }) => {
    const errors = await openFixture(page, width);
    for (const selector of CLICKABLE_ROWS) {
      const rows = page.locator(selector);
      const count = await rows.count();
      expect(count, selector).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        expect(await contract(rows.nth(index)), selector).toEqual([]);
      }
    }
    // Negative control: the old split markup fails the same contract.
    const legacy = await contract(page.getByTestId("legacy-row"));
    expect(legacy.length, "legacy split row must fail the contract").toBeGreaterThan(0);
    expect(legacy.join(" ")).toContain("surface");
    expect(errors).toEqual([]);
  });

  test(`clicking anywhere on the row fires the row action at ${width}px`, async ({ page }) => {
    await openFixture(page, width);

    // Profile: title, leading edge, trailing edge and chevron all open it.
    const personal = page.getByTestId("profile-row-personal");
    for (const where of ["title", "leading", "trailing", "chevron"] as const) {
      await clearEvents(page);
      await clickAt(page, personal, where);
      expect(await events(page), `personal/${where}`).toEqual(["profile:personal"]);
    }

    // A row with a switch: empty space and chevron open, the switch only toggles.
    const notifications = page.getByTestId("profile-row-notifications");
    for (const where of ["title", "leading", "chevron"] as const) {
      await clearEvents(page);
      await clickAt(page, notifications, where);
      expect(await events(page), `notifications/${where}`).toEqual(["profile:notifications"]);
    }
    await clearEvents(page);
    await notifications.getByRole("switch", { name: "Notifications switch" }).click();
    expect(await events(page)).toEqual(["profile:notify:false"]);

    // Consent Center: the row opens; Allow is its own action and never opens.
    const consent = page.getByTestId("consent-row-a");
    for (const where of ["title", "leading"] as const) {
      await clearEvents(page);
      await clickAt(page, consent, where);
      expect(await events(page), `consent/${where}`).toEqual(["consent:open:a"]);
    }
    await clearEvents(page);
    await consent.getByRole("button", { name: "Allow" }).click();
    expect(await events(page)).toEqual(["consent:allow:a"]);

    // Available to request: the checkbox selects without navigating...
    const financial = page
      .locator('[data-testid^="person-profile-scope-group-"]')
      .filter({ hasText: "Financial" });
    await clearEvents(page);
    const box = financial.getByRole("checkbox", { name: "Everything in Financial" });
    await box.click();
    await expect(box).toBeChecked();
    expect(await events(page)).toEqual(["toggle:13:true"]);
    await expect(page.getByTestId("person-profile-scope-back")).toHaveCount(0);

    // ...and the chevron, the count and the empty edge all open the branch.
    for (const where of ["chevron", "trailing", "leading", "title"] as const) {
      await clickAt(page, financial, where);
      await expect(page.getByTestId("person-profile-scope-back"), where).toBeVisible();
      await page.getByTestId("person-profile-scope-back").click();
      await expect(financial).toBeVisible();
    }

    // Negative control: on the legacy markup the chevron and edge do nothing.
    const legacy = page.getByTestId("legacy-row");
    await clearEvents(page);
    await clickAt(page, legacy, "chevron");
    await clickAt(page, legacy, "leading");
    expect(await events(page)).toEqual([]);
  });

  test(`hover and press paint the full row, never an inner box, at ${width}px`, async ({ page }) => {
    await openFixture(page, width, "dark");
    for (const selector of CLICKABLE_ROWS) {
      const row = page.locator(selector).first();
      await row.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      const before = await row.evaluate((node) =>
        (window as unknown as { __paintedBackgrounds: (el: Element) => string[] }).__paintedBackgrounds(node),
      );
      const title = (await row.locator('[data-slot="settings-row-title"]').first().boundingBox())!;
      await page.mouse.move(title.x + 4, title.y + title.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(200);
      const changed = await row.evaluate(
        (node, prior) =>
          (window as unknown as {
            __changedBackgroundBoxes: (el: Element, b: string[]) => Array<{ full: boolean }>;
          }).__changedBackgroundBoxes(node, prior),
        before,
      );
      await page.mouse.up();
      // Releasing on the title opens the branch; return so the next row is where it was.
      const back = page.getByTestId("person-profile-scope-back");
      if (await back.count()) await back.click();
      expect(changed.length, `${selector} must show a pressed surface`).toBeGreaterThan(0);
      expect(changed.filter((entry) => !entry.full), selector).toEqual([]);
    }
  });

  test(`the focus ring is on the row, inside its edges, at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    for (const selector of CLICKABLE_ROWS) {
      const row = page.locator(selector).first();
      await page.keyboard.press("Shift");
      const surface = row.locator('button:not([data-slot="settings-row-trailing"] *)').first();
      await surface.focus();
      const state = await surface.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const rowBox = el.closest("[data-row-layout]")!.getBoundingClientRect();
        return {
          focusVisible: el.matches(":focus-visible"),
          shadow: getComputedStyle(el).boxShadow,
          full: Math.abs(r.width - rowBox.width) <= 1 && Math.abs(r.height - rowBox.height) <= 1,
        };
      });
      expect(state.focusVisible, selector).toBe(true);
      expect(state.full, selector).toBe(true);
      // An outset ring is clipped by the row and the group's overflow-hidden;
      // only an inset ring is actually visible.
      expect(state.shadow, selector).toContain("inset");
      await surface.blur();
    }
  });

  test(`rows stay inside their card with Linux-wide text at ${width}px`, async ({ page }) => {
    // CI's Linux fonts render about 1.5px wider than a Mac. Widen on purpose.
    await openFixture(page, width, "light", "[data-testid^=consumer-]{letter-spacing:0.03em}");
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll("[data-row-layout]")].flatMap((row) => {
        const box = row.getBoundingClientRect();
        return [...row.querySelectorAll("*")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
          })
          .map((el) => `${row.getAttribute("data-testid")}: ${el.tagName}`);
      }),
    );
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const width of [320, 393, 834, 1440]) {
  test(`navigation siblings preserve uniform readable full-row surfaces at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    const group = page.getByTestId("uniform-navigation");
    const rows = group.getByTestId("settings-row");
    const measure = () => rows.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    const spread = (heights: number[]) => Math.max(...heights) - Math.min(...heights);
    expect(spread(await measure())).toBeLessThanOrEqual(1);
    for (const row of await rows.all()) expect(await contract(row)).toEqual([]);
    const originalHeight = (await measure())[0]!;
    const walletGroups = ["active", "paused"].map((status) => page.getByTestId(`consumer-wallet-${status}`)
      .getByTestId("settings-group").filter({ hasText: "Sharing controls" }));
    const voiceGroup = page.getByTestId("voice-control-domains");
    const mailGroups = ["connected", "reconnect", "unavailable", "busy", "connected-busy"].map((state) =>
      page.getByTestId(`consumer-mail-${state}`).getByTestId("mail-actions-group"));
    const boundedGroups = [
      ...["portfolio-source-add-group", "portfolio-import-source-options"].map((id) => page.getByTestId(id)),
      ...walletGroups,
      voiceGroup,
      ...mailGroups,
    ];
    async function verifyBoundedConsumers() {
      for (const source of boundedGroups) {
        const siblings = source.locator("[data-row-layout]");
        const heights = await siblings.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        expect(heights.length).toBeGreaterThan(1); // Real consumers, not an empty fixture.
        expect(spread(heights)).toBeLessThanOrEqual(1);
        for (const row of await siblings.all()) {
          // Voice rows intentionally have only a trailing switch or a passive
          // Coming soon badge; they are not full-row navigation actions.
          if (source !== voiceGroup) expect(await contract(row)).toEqual([]);
          expect(await row.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return [...node.querySelectorAll('[data-slot="settings-row-title"],[data-slot="settings-row-description"]')]
              .every((text) => {
                const box = text.getBoundingClientRect();
                return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 &&
                  box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1 && text.scrollHeight <= text.clientHeight + 1;
              });
          })).toBe(true);
        }
      }
      for (const wallet of walletGroups) {
        expect(await wallet.locator("[data-row-layout]").count()).toBe(5);
        const descriptions = await wallet.locator('[data-slot="settings-row-description"]').allTextContents();
        expect(descriptions).toHaveLength(5);
        expect(descriptions.every((text) => text.trim().length > 0)).toBe(true);
      }
      expect(await voiceGroup.locator("[data-row-layout]").count()).toBe(8);
      expect(await voiceGroup.locator('[data-slot="settings-row-action"]').count()).toBe(0);
      for (const [index, mail] of mailGroups.entries()) {
        expect(await mail.locator("[data-row-layout]").count()).toBe(index === 0 || index === 4 ? 4 : 3);
      }
      for (const source of [voiceGroup, ...mailGroups]) {
        const descriptions = source.locator('[data-slot="settings-row-description"]');
        expect(await descriptions.count()).toBe(await source.locator("[data-row-layout]").count());
        expect((await descriptions.allTextContents()).every((text) => text.trim().length > 0)).toBe(true);
      }
    }
    await verifyBoundedConsumers();
    // Enlarged text makes two-line support copy grow rather than disappear.
    await page.addStyleTag({ content: '[data-testid$="navigation"], [data-testid="portfolio-source-add-group"], [data-testid="portfolio-import-source-options"], [data-testid^="consumer-wallet-"], [data-testid="voice-control-domains"], [data-testid="mail-actions-group"] { max-width: 300px; --type-row-label-size: 24px; --type-row-label-line: 32px; --type-row-description-size: 24px; --type-row-description-line: 32px; }' });
    await verifyBoundedConsumers();
    expect(spread(await measure())).toBeLessThanOrEqual(1);
    expect((await measure())[0]!).toBeGreaterThan(originalHeight);
    for (const row of await rows.all()) expect(await contract(row)).toEqual([]);
    const description = group.locator('[data-slot="settings-row-description"]').last();
    expect(await description.evaluate((node) => getComputedStyle(node).fontSize)).toBe("24px");
    expect(await description.evaluate((node) => getComputedStyle(node).lineHeight)).toBe("32px");
    expect(await description.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    for (const wallet of walletGroups) {
      expect(await wallet.locator('[data-slot="settings-row-description"]').first().evaluate((node) => {
        const style = getComputedStyle(node);
        return { fontSize: style.fontSize, lineHeight: style.lineHeight };
      })).toEqual({ fontSize: "24px", lineHeight: "32px" });
    }
    for (const source of [voiceGroup, ...mailGroups]) {
      expect(await source.locator('[data-slot="settings-row-description"]').evaluateAll((nodes) =>
        nodes.every((node) => getComputedStyle(node).fontSize === "24px" &&
          getComputedStyle(node).lineHeight === "32px"))).toBe(true);
    }
    for (const row of await rows.all()) {
      expect(await row.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return [...node.querySelectorAll('[data-slot="settings-row-title"],[data-slot="settings-row-description"]')]
          .every((text) => {
            const box = text.getBoundingClientRect();
            return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 &&
              box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
          });
      }), "readable text remains inside its row, not clipped by an ancestor").toBe(true);
    }
    // The same mixed-content group without uniform sizing detects the defect.
    const contentHeights = await page.getByTestId("content-navigation").getByTestId("settings-row")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(spread(contentHeights)).toBeGreaterThan(1);
    await clearEvents(page);
    await clickAt(page, rows.first(), "trailing");
    expect(await events(page)).toEqual(["uniform:account"]);
    await clearEvents(page);
    await group.getByRole("switch", { name: "Synthetic security switch" }).click();
    expect(await events(page)).toEqual(["uniform:switch"]);
    for (const [index, status] of ["active", "paused"].entries()) {
      const walletRows = walletGroups[index]!.locator("[data-row-layout]");
      for (const [row, action] of ["preview", "edit", status === "active" ? "pause" : "resume", "rotate", "remove"].entries()) {
        await clearEvents(page);
        await clickAt(page, walletRows.nth(row), "trailing");
        expect(await events(page)).toEqual([`wallet:${status}:${action}`]);
      }
    }
    await clearEvents(page);
    await voiceGroup.getByRole("switch", { name: "Location", exact: true }).click();
    expect(await events(page)).toEqual(["voice:location:false"]);
    for (const [index, state] of ["connected", "reconnect", "unavailable", "busy", "connected-busy"].entries()) {
      await clearEvents(page);
      await clickAt(page, mailGroups[index]!.locator("[data-row-layout]").first(), "trailing");
      expect(await events(page)).toEqual(index < 2 ? [`mail:${state}:${index === 0 ? "sync" : "connect"}`] : []);
    }
    await clearEvents(page);
    await clickAt(page, mailGroups[4]!.locator("[data-row-layout]").last(), "trailing");
    expect(await events(page)).toEqual([]); // A busy disconnect cannot be replayed.
  });
}

for (const width of [393, 834, 1440]) {
  test(`detail Close has a reachable 44px target at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    await page.getByRole("button", { name: "Open detail target" }).click();
    const close = page.getByRole("button", { name: "Close detail panel", exact: true });
    await expect(close).toBeVisible();
    // Wait for the shared entrance, not a guessed sleep or hidden duplicate.
    await close.click({ trial: true });
    const box = (await close.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const heading = page.getByRole("heading", { name: "Request details", exact: true });
    const titleBox = (await heading.boundingBox())!;
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(box.x + 1);
    // The extra hit area must reach the real close handler, not just measure larger.
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
    await expect(close).toBeHidden();
    await expect(heading).toBeHidden();
  });
}

/**
 * Evidence captures, not assertions. Run with ROW_SHOTS_DIR and ROW_SHOTS_PHASE
 * to write the before/after screenshots the change was reviewed against.
 */
const shotsDir = process.env.ROW_SHOTS_DIR;
const shotsPhase = process.env.ROW_SHOTS_PHASE ?? "after";
for (const width of [393, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`captures consumer rows at ${width}px ${theme}`, async ({ page }, info) => {
      test.skip(!shotsDir || info.project.name !== "chromium", "evidence capture only");
      await openFixture(page, width, theme);
      const consumers = {
        "person-profile": "consumer-person-profile",
        "profile-settings": "consumer-profile-settings",
        "consent-center": "consumer-consent-center",
        "chat-card": "consumer-chat-card",
        "wallet-active": "consumer-wallet-active",
        "wallet-paused": "consumer-wallet-paused",
      };
      for (const [name, testId] of Object.entries(consumers)) {
        await page.getByTestId(testId).screenshot({
          path: path.join(shotsDir!, `row-${shotsPhase}-${name}-${width}-${theme}.png`),
        });
      }
      // The reported state: pressing "Financial".
      const financial = page
        .locator('[data-testid^="person-profile-scope-group-"]')
        .filter({ hasText: "Financial" });
      const title = (await financial.locator('[data-slot="settings-row-title"]').boundingBox())!;
      await page.mouse.move(title.x + 4, title.y + title.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(250);
      await page.getByTestId("consumer-person-profile").screenshot({
        path: path.join(shotsDir!, `row-${shotsPhase}-person-profile-pressed-${width}-${theme}.png`),
      });
      await page.mouse.up();
    });
