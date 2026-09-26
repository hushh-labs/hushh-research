import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/** Real product tokens and Profile/Connector CSS at phone, tablet, and desktop widths. */
const WIDTHS = [320, 768, 1440] as const;

async function fixtureUrl(theme: "light" | "dark"): Promise<string> {
  const root = process.cwd();
  const { compile } = (await import(
    pathToFileURL(path.join(root, "node_modules/tailwindcss/dist/lib.mjs")).href
  )) as {
    compile: (
      css: string,
      options: unknown,
    ) => Promise<{ build: (candidates: string[]) => string }>;
  };
  const globals = fs
    .readFileSync(path.join(root, "app/globals.css"), "utf8")
    .replace(/^@source\s+[^;]+;\s*$/gm, "");
  const compiler = await compile(globals, {
    base: path.join(root, "app"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
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
  });
  const css = stripAppFontFaces(compiler.build([]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-settings-theme-"));
  const page = `<!doctype html><html class="${theme === "dark" ? "dark" : ""}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${productFontStyle()}</style><style>${css}</style>
<style>
body { margin: 0; }
.test-frame { box-sizing: border-box; width: min(100%, 600px); margin-inline: auto; padding: 16px; }
.test-heading { margin: 0 0 10px; }
.test-row { box-sizing: border-box; min-height: 60px; display: grid; grid-template-columns: 34px minmax(0,1fr) auto; align-items: center; gap: 12px; padding: 10px 16px; }
.test-row-title { min-width: 0; overflow-wrap: anywhere; }
.test-action { min-height: 44px; border: 0; border-radius: 999px; padding-inline: 12px; background: var(--app-settings-surface); color: var(--app-settings-link); }
.test-connector-frame { box-sizing: border-box; width: min(100%, 520px); margin: 20px auto 0; padding: 16px; }
.test-connector-heading { margin: 0 0 16px; font: 700 24px/1.2 var(--font-app-display); }
</style></head><body>
<main class="profile-home-screen test-frame">
  <div class="profile-home-content">
    <section data-testid="settings-group">
      <div><h2 data-slot="settings-group-heading" class="test-heading">Profile settings</h2></div>
      <div data-slot="settings-group-shell">
        <div data-testid="settings-row" class="test-row">
          <span data-slot="settings-row-icon" data-icon-tone="blue"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18" fill="none" stroke="currentColor"/></svg></span>
          <span data-slot="settings-row-title" class="test-row-title">Privacy and connections for a very long profile name</span>
          <button class="test-action">View</button>
        </div>
      </div>
    </section>
  </div>
</main>
<section data-profile-stack-content="true" class="test-frame" aria-label="Nested profile settings">
  <div data-testid="settings-group">
    <div><h2 data-slot="settings-group-heading" class="test-heading">Security</h2></div>
    <div data-slot="settings-group-shell">
      <div data-testid="settings-row" data-tone="default" class="test-row">
        <span data-slot="settings-row-icon" data-icon-tone="blue"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18" fill="none" stroke="currentColor"/></svg></span>
        <span data-slot="settings-row-title" class="test-row-title">Connected devices and security preferences for a very long account name</span>
        <button class="test-action">View</button>
      </div>
    </div>
  </div>
</section>
<section class="profile-account-content test-frame" aria-label="Account actions">
  <div data-tone="destructive" class="test-row">
    <span data-slot="settings-row-icon">×</span>
    <span data-slot="settings-row-title" class="test-row-title">Delete account</span>
  </div>
</section>
<aside data-slot="connectors-panel" class="test-connector-frame">
  <h2 class="test-connector-heading">Connectors</h2>
  <section data-testid="settings-group">
    <div><h3 data-slot="settings-group-heading" class="test-heading">Available</h3></div>
    <div data-slot="settings-group-shell">
      <div data-testid="settings-row" class="test-row">
        <span data-slot="settings-row-icon" data-icon-tone="blue">✦</span>
        <span data-slot="settings-row-title" class="test-row-title">Google Workspace</span>
        <button class="test-action">Connect</button>
      </div>
    </div>
  </section>
</aside></body></html>`;
  const file = path.join(dir, "fixture.html");
  fs.writeFileSync(file, page);
  return pathToFileURL(file).href;
}

function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Unexpected color: ${color}`);
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

for (const theme of ["light", "dark"] as const) {
  for (const width of WIDTHS) {
    test(`${theme} Profile and Connectors remain readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await fixtureUrl(theme));
      await awaitProductFont(page);
      const state = await page.evaluate(() => {
        const profile = document.querySelector<HTMLElement>(".profile-home-screen")!;
        const profileCard = profile.querySelector<HTMLElement>("[data-slot='settings-group-shell']")!;
        const profileTitle = profile.querySelector<HTMLElement>("[data-slot='settings-row-title']")!;
        const profileIconWell = profile.querySelector<HTMLElement>("[data-slot='settings-row-icon']")!;
        const profileIcon = profileIconWell.querySelector<SVGElement>("svg")!;
        const nested = document.querySelector<HTMLElement>("[data-profile-stack-content='true']")!;
        const nestedCard = nested.querySelector<HTMLElement>("[data-slot='settings-group-shell']")!;
        const nestedTitle = nested.querySelector<HTMLElement>("[data-slot='settings-row-title']")!;
        const nestedIconWell = nested.querySelector<HTMLElement>("[data-slot='settings-row-icon']")!;
        const nestedIcon = nestedIconWell.querySelector<SVGElement>("svg")!;
        const accountIcon = document.querySelector<HTMLElement>(
          ".profile-account-content [data-slot='settings-row-icon']",
        )!;
        const connectors = document.querySelector<HTMLElement>("[data-slot='connectors-panel']")!;
        const connectorCard = connectors.querySelector<HTMLElement>("[data-slot='settings-group-shell']")!;
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          bodyBackground: getComputedStyle(document.body).backgroundColor,
          font: getComputedStyle(profileTitle).fontFamily,
          profileBackground: getComputedStyle(profile).backgroundColor,
          profileCard: getComputedStyle(profileCard).backgroundColor,
          profileTitle: getComputedStyle(profileTitle).color,
          profileIcon: getComputedStyle(profileIcon).color,
          profileIconBackground: getComputedStyle(profileIconWell).backgroundColor,
          nestedCard: getComputedStyle(nestedCard).backgroundColor,
          nestedTitle: getComputedStyle(nestedTitle).color,
          nestedIcon: getComputedStyle(nestedIcon).color,
          nestedIconBackground: getComputedStyle(nestedIconWell).backgroundColor,
          accountIcon: getComputedStyle(accountIcon).color,
          accountIconBackground: getComputedStyle(accountIcon).backgroundColor,
          connectorBackground: getComputedStyle(connectors).backgroundColor,
          connectorCard: getComputedStyle(connectorCard).backgroundColor,
          connectorTitle: getComputedStyle(connectors.querySelector("h2")!).color,
          actionHeights: [...document.querySelectorAll<HTMLElement>(".test-action")].map(
            (button) => button.getBoundingClientRect().height,
          ),
          actionColors: [...document.querySelectorAll<HTMLElement>(".test-action")].map(
            (button) => ({
              foreground: getComputedStyle(button).color,
              background: getComputedStyle(button).backgroundColor,
            }),
          ),
        };
      });
      expect(state.pageWidth).toBeLessThanOrEqual(state.viewportWidth + 1);
      expect(state.font).toContain("DMSansVariable");
      expect(state.profileCard).toBe(state.connectorCard);
      expect(state.nestedCard).toBe(state.profileCard);
      expect(state.profileBackground).toBe(state.connectorBackground);
      expect(state.bodyBackground).toBe(state.profileBackground);
      expect(state.profileCard).not.toBe(state.profileBackground);
      expect(state.profileIconBackground).not.toBe(state.profileCard);
      expect(state.nestedIconBackground).not.toBe(state.profileIconBackground);
      expect(state.nestedIconBackground).not.toBe(state.nestedCard);
      const accountIconLight = Math.max(
        luminance(state.accountIcon), luminance(state.accountIconBackground),
      );
      const accountIconDark = Math.min(
        luminance(state.accountIcon), luminance(state.accountIconBackground),
      );
      expect((accountIconLight + 0.05) / (accountIconDark + 0.05)).toBeGreaterThanOrEqual(3);
      expect(state.actionHeights.every((height) => height >= 44)).toBe(true);
      for (const [foreground, background] of [
        [state.profileTitle, state.profileCard],
        [state.nestedTitle, state.nestedCard],
        [state.connectorTitle, state.connectorBackground],
        ...state.actionColors.map(({ foreground, background }) => [foreground, background]),
      ]) {
        const light = Math.max(luminance(foreground), luminance(background));
        const dark = Math.min(luminance(foreground), luminance(background));
        expect(
          (light + 0.05) / (dark + 0.05),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const [foreground, background] of [
        [state.profileIcon, state.profileIconBackground],
        [state.nestedIcon, state.nestedIconBackground],
      ]) {
        const light = Math.max(luminance(foreground), luminance(background));
        const dark = Math.min(luminance(foreground), luminance(background));
        expect(
          (light + 0.05) / (dark + 0.05),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(3);
      }
      if (process.env.PROFILE_THEME_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.PROFILE_THEME_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.PROFILE_THEME_EVIDENCE_DIR, `${theme}-${width}.png`),
        });
      }
    });
  }
}
