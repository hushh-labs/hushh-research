import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let profileClass: string;
let dialogClass: string;
let calendarCss: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const profile = fs.readFileSync(path.join(root, "components/app-ui/profile-pane.tsx"), "utf8");
  const sheet = fs.readFileSync(path.join(root, "components/ui/sheet.tsx"), "utf8");
  profileClass = [
    profile.match(/className="(profile-pane-sheet[^"]+)"/)![1],
    sheet.match(/"(data-\[state=open\]:animate-in data-\[state=closed\]:animate-out fixed[^"]+)"/)![1],
    sheet.match(/side === "right" &&\s*"([^"]+)"/)![1],
  ].join(" ");
  const dialog = fs.readFileSync(path.join(root, "components/ui/dialog.tsx"), "utf8");
  dialogClass = dialog.match(/"(data-\[state=open\]:animate-in[^"\n]*fixed top-\[50%\][^"\n]*)"/)![1];
  calendarCss = fs.readFileSync(path.join(root, "components/calendar/calendar-booking-dialog.module.css"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...profileClass.split(/\s+/), ...dialogClass.split(/\s+/), "whitespace-nowrap"]));
  const { transform } = await import("lightningcss");
  css = transform({ filename: "mobile-overlay-safe-area.css", code: Buffer.from(css), minify: true }).code.toString();
});

test("native rotation overrides a stale portrait safe-area probe", async ({ page }) => {
  await page.setContent(`<html class="native-ios" style="--app-native-safe-area-top:64px;--app-safe-area-top-probe:64px"><head><style>${css}</style></head><body><div id="inset" style="height:var(--app-safe-area-top-effective)"></div></body></html>`);
  await expect(page.locator("#inset")).toHaveCSS("height", "64px");
  await page.evaluate(() => document.documentElement.style.setProperty("--app-native-safe-area-top", "0px"));
  await expect(page.locator("#inset")).toHaveCSS("height", "0px");
});

test("opening mobile Profile preserves the canvas and exits beyond its bounded inset", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<html class="native-ios" style="--app-native-safe-area-top:59px"><head><style>${css}</style></head><body><div class="foundation-public-ambient"></div><nav class="kai-bottom-nav-pill"></nav></body></html>`);
  const snapshot = () => page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    ambient: getComputedStyle(document.querySelector(".foundation-public-ambient")!).display,
    nav: getComputedStyle(document.querySelector("nav")!).backgroundColor,
  }));
  const before = await snapshot();
  await page.evaluate((className) => {
    const pane = document.createElement("section");
    pane.className = className;
    pane.dataset.slot = "sheet-content";
    pane.dataset.sheetSide = "right";
    pane.dataset.state = "open";
    pane.style.position = "fixed";
    pane.innerHTML = '<header class="profile-pane-header"><h2>Profile</h2></header><button class="profile-pane-close" style="position:absolute;width:44px;height:44px" aria-label="Close Profile">Close</button><div class="profile-home-screen profile-account-content" data-profile-stack="true">Profile</div>';
    document.body.append(pane);
  }, profileClass);
  expect(await snapshot()).toEqual(before);
  const pane = page.locator(".profile-pane-sheet");
  // The frame is edge-to-edge; its actual controls, not the frame, clear the
  // status area even when WKWebView reports a zero env() inset.
  expect((await pane.boundingBox())!.y).toBe(0);
  expect((await pane.boundingBox())!.height).toBe(844);
  expect((await pane.getByRole("heading", { name: "Profile" }).boundingBox())!.y).toBeGreaterThanOrEqual(59);
  expect((await pane.getByRole("button", { name: "Close Profile" }).boundingBox())!.y).toBeGreaterThanOrEqual(59);
  await pane.evaluate(node => {
    node.setAttribute("data-state", "closed");
    const animation = node.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === "sheet-surface-exit" && a.effect instanceof KeyframeEffect && a.effect.target === node);
    if (!animation) throw new Error("Profile exit animation missing");
    const duration = Number(animation.effect!.getTiming().duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Profile exit duration invalid");
    animation.pause();
    animation.currentTime = duration - 0.01;
  });
  expect((await pane.boundingBox())!.x).toBeGreaterThanOrEqual(389);
  await pane.evaluate(node => node.remove());
  expect(await snapshot()).toEqual(before);
});


test("reserved centered dialog counts keyboard clearance once and bounds the booking form", async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await page.setContent(`<html class="native-ios kb-open" style="--native-overlay-top:154px;--native-overlay-bottom:335px;--kb-height:335px;--app-native-safe-area-top:62px"><head><style>${css} ${calendarCss}</style></head><body><div data-native-workspace-seat="true"></div><section data-slot="dialog-content" class="${dialogClass} dialog"><h2>Schedule meeting</h2><div class="fields"><label>Title<input style="width:100%;min-width:0" /></label><label>Calendar account and destination<select><option>long-calendar-owner@example.com · Primary calendar</option></select></label><button class="whitespace-nowrap">Allow scheduling on long-calendar-owner@example.com</button></div></section></body></html>`);
  const dialog = page.locator('[data-slot="dialog-content"]');
  const metrics = await dialog.evaluate(node => [node, ...node.querySelectorAll(".fields,label,input,select,button,h2")].map(n => ({ tag: n.tagName, width: n.getBoundingClientRect().width, scroll: n.scrollWidth, min: getComputedStyle(n).minWidth, grid: getComputedStyle(n).gridTemplateColumns, whiteSpace: getComputedStyle(n).whiteSpace })));
  const metricsPath = test.info().outputPath("booking-layout-metrics.json");
  fs.writeFileSync(metricsPath, JSON.stringify(metrics));
  await test.info().attach("booking-layout-metrics", { path: metricsPath, contentType: "application/json" });
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(154);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(874 - 335);
  expect(await dialog.evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(await dialog.evaluate(node => node.clientWidth));
  await expect(dialog).toHaveCSS("margin-top", "0px");
  // Renderer-off continues to use the existing ordinary keyboard lift.
  await page.locator('[data-native-workspace-seat]').evaluate(node => node.remove());
  await expect(dialog).toHaveCSS("margin-top", "-167.5px");
});

test("full-screen Profile owns nested sheet clearance instead of the covered workspace", async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await page.setContent(`<html class="native-ios" style="--native-workspace-top:154px;--native-workspace-bottom:179px;--kb-height:0px"><head><style>${css}</style></head><body><div data-native-workspace-seat="true"></div><section class="native-feature-page" data-native-feature-pane="profile" data-state="open"></section><section data-slot="sheet-content" data-sheet-side="bottom" style="position:fixed;height:313px;width:100%"></section></body></html>`);
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet).toHaveCSS("bottom", "0px");
  await page.evaluate(() => document.documentElement.style.setProperty("--kb-height", "335px"));
  await expect(sheet).toHaveCSS("bottom", "335px");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--kb-height", "0px");
    document.querySelector(".native-feature-page")!.setAttribute("data-state", "closed");
  });
  await expect(sheet).toHaveCSS("bottom", "179px");
});
