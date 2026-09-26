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

/**
 * The authorization route is protected. This fixture reads its shipping class
 * strings and CSS, then supplies only long sample account/device values.
 */
async function fixtureUrl(theme: "light" | "dark"): Promise<string> {
  const root = process.cwd();
  const source = fs.readFileSync(
    path.join(root, "app/one/profile/security/devices/authorize/page.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const classAfter = (anchor: string): string => {
    const start = source.indexOf(anchor);
    if (start < 0) throw new Error(`Authorization source marker missing: ${anchor}`);
    const match = /className="([^"]+)"/.exec(source.slice(start));
    if (!match) throw new Error(`Authorization class missing after: ${anchor}`);
    return match[1];
  };
  const mainClass = classAfter('data-one-workspace="profile-authorization"');
  const cardClass = classAfter("<section className=");
  const headingClass = classAfter("<h1 className=");
  const descriptionClass = classAfter("<p className=");
  const detailsClass = classAfter("<dl className=");
  const detailRowClass = classAfter('<div className="grid grid-cols-');
  const detailLabelClass = classAfter("<dt className=");
  const detailValueClass = classAfter("<dd className=");
  const actionClass = classAfter("<Button\n          className=");
  const markup = `<main data-one-workspace="profile-authorization" class="${mainClass}">
    <section data-testid="authorization-card" class="${cardClass}">
      <h1 class="${headingClass}">Connect this Hermes device</h1>
      <p class="${descriptionClass}">Approve this private computer as an extension of One.</p>
      <dl data-testid="device-details" class="${detailsClass}">
        <div class="${detailRowClass}"><dt class="${detailLabelClass}">Hussh account</dt><dd data-testid="account-value" class="${detailValueClass}">very.long.account.identity.with.multiple.sections@extraordinarily-long-university-domain.example</dd></div>
        <div class="${detailRowClass}"><dt class="${detailLabelClass}">Device</dt><dd data-testid="device-value" class="${detailValueClass}">Hermes MacBook Pro for the Featherstonehaugh-Rajendran International Household</dd></div>
      </dl>
      <button class="${actionClass}">Approve device</button>
    </section>
  </main>`;
  const candidates = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) candidates.add(token);
  }

  const { compile } = await import(
    pathToFileURL(path.join(root, "node_modules/tailwindcss/dist/lib.mjs")).href
  );
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
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  const css = stripAppFontFaces(compiler.build([...candidates]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-device-theme-"));
  const file = path.join(dir, "fixture.html");
  fs.writeFileSync(
    file,
    `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${productFontStyle()}</style><style>${css}</style></head><body>${markup}</body></html>`,
  );
  return pathToFileURL(file).href;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!values || values.length !== 3) throw new Error(`Unexpected color: ${color}`);
    const [red, green, blue] = values.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (light + 0.05) / (dark + 0.05);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 768, 1440] as const) {
    test(`${theme} trusted-device authorization wraps at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await fixtureUrl(theme));
      await awaitProductFont(page);
      const state = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("[data-testid='authorization-card']")!;
        const details = document.querySelector<HTMLElement>("[data-testid='device-details']")!;
        const heading = card.querySelector<HTMLElement>("h1")!;
        const values = [...details.querySelectorAll<HTMLElement>("dd")];
        const cardRect = card.getBoundingClientRect();
        return {
          pageWidth: document.documentElement.scrollWidth,
          cardLeft: cardRect.left,
          cardRight: cardRect.right,
          cardBackground: getComputedStyle(card).backgroundColor,
          headingColor: getComputedStyle(heading).color,
          headingFont: getComputedStyle(heading).fontFamily,
          detailsBackground: getComputedStyle(details).backgroundColor,
          values: values.map((value) => ({
            color: getComputedStyle(value).color,
            left: value.getBoundingClientRect().left,
            right: value.getBoundingClientRect().right,
            scrollWidth: value.scrollWidth,
            clientWidth: value.clientWidth,
          })),
          buttonHeight: card.querySelector("button")!.getBoundingClientRect().height,
        };
      });
      expect(state.pageWidth).toBeLessThanOrEqual(width + 1);
      expect(state.cardLeft).toBeGreaterThanOrEqual(0);
      expect(state.cardRight).toBeLessThanOrEqual(width + 1);
      expect(state.headingFont).toContain("DMSansVariable");
      expect(contrastRatio(state.headingColor, state.cardBackground)).toBeGreaterThanOrEqual(4.5);
      for (const value of state.values) {
        expect(value.left).toBeGreaterThanOrEqual(state.cardLeft);
        expect(value.right).toBeLessThanOrEqual(state.cardRight + 1);
        expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth + 1);
        expect(contrastRatio(value.color, state.detailsBackground)).toBeGreaterThanOrEqual(4.5);
      }
      expect(state.buttonHeight).toBeGreaterThanOrEqual(44);
    });
  }
}
