import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
let icons: typeof import("@phosphor-icons/react");
import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

/** CSS geometry contract for the profile action cluster, using its shipped CSS.
 * Functional composition, gates and dialogs are exercised by person-profile-page.test.tsx.
 * Keep this fixture's Morphy content/ripple wrappers and reading order aligned with that proof.
 */
let server: Server;
let origin: string;
const icon = (className = "", Icon = icons.FileText) => renderToStaticMarkup(createElement(Icon, { className, "aria-hidden": true }));
const button = (id: string, label: string, className = "", content = label) => `<button class="${className}" data-id="${id}"><span>${content}</span><span data-ripple aria-hidden="true"></span></button>`;
const card = (id: string, label: string, Icon = icons.FileText) => button(id, label, "", `<span class="actionCardContent">${icon("actionIcon", Icon)}${icon("actionArrow", icons.ArrowUpRight)}<span class="actionLabel">${label}</span></span>`);
const markup = () => `<div class="hero"><div class="actions" aria-label="Relationship actions">
${button("request", "Request", "request primary", `${icon()}Request`)}${button("share", "Share", "share", `${icon("", icons.ShareNetwork)}Share`)}
<div class="actionCards">${card("request-files", "Request files")}${card("ask-about-files", "Ask about files", icons.ChatCircle)}${card("request-scope", "Request scope", icons.ShieldCheck)}${card("request-cards", "Request cards", icons.CreditCard)}</div>
${button("packets", "Available packets", "packets")}
${button("manage", "Manage access", "manage", `${icon("", icons.Gear)}<span>Manage access</span>${icon("", icons.CaretRight)}`)}
</div></div>`;

test.beforeAll(async () => {
  icons = await import("@phosphor-icons/react");
  const css = readFileSync(path.join(process.cwd(), "components/connections/person-profile-page.module.css"), "utf8");
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      ${productFontStyle()}
      :root{--foreground:#1d1d1f;--muted-foreground:#6e6e73;--app-accent:#0071e3;--app-accent-fg:#fff;--border:#e5e5ea;--app-card-radius-feature:20px;--app-card-border-standard:#e5e5ea;--app-card-surface-default-solid:#fff}
      .dark{--foreground:#f5f5f7;--muted-foreground:#a1a1a6;--border:#38383a;--app-card-border-standard:#38383a;--app-card-surface-default-solid:#1c1c1e;color-scheme:dark;background:#000}
      *{box-sizing:border-box}body{margin:0;padding:16px;color:var(--foreground)}button{font:inherit;cursor:pointer;color:inherit;border:0;background:transparent}button>span:first-child{display:inline-flex;align-items:center;justify-content:center}svg{width:20px;height:20px}button:focus-visible{outline:2px solid var(--app-accent);outline-offset:3px}.primary{background:var(--app-accent);color:var(--app-accent-fg)}
      ${css}</style></head><body>${markup()}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

async function boxes(page: Page) {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-id]")].map((el) => {
    const { top, bottom, left, right, width, height } = el.getBoundingClientRect();
    return [el.dataset.id!, { top, bottom, left, right, width, height }];
  })));
}
for (const width of [320, 375, 420, 768, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`rounded action cards fit and keep a readable order at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin);
      await page.locator("html").evaluate((el, value) => el.classList.toggle("dark", value === "dark"), theme);
      await awaitProductFont(page);
      const rect = await boxes(page);
      expect(Math.abs(rect["request-files"].top - rect["ask-about-files"].top)).toBeLessThan(1);
      expect(Math.abs(rect["request-scope"].top - rect["request-cards"].top)).toBeLessThan(1);
      expect(rect["request-scope"].top).toBeGreaterThanOrEqual(rect["request-files"].bottom);
      for (const pair of [["request-files", "ask-about-files"], ["request-scope", "request-cards"]]) {
        for (const part of [".actionIcon", ".actionLabel"]) {
          const tops = await Promise.all(pair.map(async name => page.locator(`[data-id="${name}"] ${part}`).evaluate(el => el.getBoundingClientRect().top)));
          expect(Math.abs(tops[0] - tops[1])).toBeLessThan(1);
        }
      }
      expect(rect.packets.top).toBeGreaterThanOrEqual(rect["request-cards"].bottom);
      expect(rect.manage.top).toBeGreaterThanOrEqual(rect.packets.bottom);
      for (const name of ["request-files", "ask-about-files", "request-scope", "request-cards"]) {
        expect(rect[name].height).toBeGreaterThanOrEqual(44);
        expect(rect[name].width).toBeCloseTo(rect["request-files"].width, 0);
        const card = page.locator(`[data-id="${name}"]`);
        const geometry = await card.evaluate((el) => {
          const icon = el.querySelector(".actionIcon")!, label = el.querySelector(".actionLabel")!;
          return { icon: icon.getBoundingClientRect().width, iconBottom: icon.getBoundingClientRect().bottom, labelTop: label.getBoundingClientRect().top, radius: parseFloat(getComputedStyle(el).borderRadius) };
        });
        expect(geometry.icon).toBe(20);
        expect(geometry.labelTop).toBeGreaterThan(geometry.iconBottom);
        expect(geometry.radius).toBe(20);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if (width === 1280) expect(await page.locator(".actions").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(560);
      if ((width === 375 || width === 1280) && theme === "light") await page.locator(".actions").screenshot({ path: testInfo.outputPath("actions.png") });
    });
  }
}

test("long and sent labels wrap, missing file actions leave no holes, and keyboard focus stays visible", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(origin);
  await page.locator('[data-id="request-cards"] .actionLabel').evaluate(el => { el.textContent = "Card request sent — طلب مشاركة البطاقة"; });
  await page.locator('[data-id="request-files"], [data-id="ask-about-files"], [data-id="packets"]').evaluateAll(elements => elements.forEach(el => el.remove()));
  const rect = await boxes(page);
  expect(Math.abs(rect["request-scope"].top - rect["request-cards"].top)).toBeLessThan(1);
  expect(rect.manage.top).toBeGreaterThanOrEqual(rect["request-cards"].bottom);
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(page.getByRole("button", { name: "Request", exact: true })).toBeFocused();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  const scope = page.getByRole("button", { name: "Request scope", exact: true });
  await expect(scope).toBeFocused();
  expect(await scope.evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.locator(".actionCards").evaluate(el => { el.innerHTML = ""; });
  await page.locator('[data-id="request"], [data-id="manage"]').evaluateAll(elements => elements.forEach(el => el.remove()));
  await page.locator(".actions").evaluate(el => { el.setAttribute("data-share-only", "true"); });
  const share = await boxes(page);
  expect(share.share.width).toBeCloseTo(await page.locator(".actions").evaluate(el => el.getBoundingClientRect().width), 0);
});
