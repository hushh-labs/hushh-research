import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let profileClass: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const profile = fs.readFileSync(path.join(root, "components/app-ui/profile-pane.tsx"), "utf8");
  const sheet = fs.readFileSync(path.join(root, "components/ui/sheet.tsx"), "utf8");
  profileClass = [
    profile.match(/className="(profile-pane-sheet[^"]+)"/)![1],
    sheet.match(/"(data-\[state=open\]:animate-in data-\[state=closed\]:animate-out fixed[^"]+)"/)![1],
    sheet.match(/side === "right" &&\s*"([^"]+)"/)![1],
  ].join(" ");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build(profileClass.split(/\s+/)));
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
