import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let outDir: string;

/** Real profile presentation, optimized app CSS and shipped font.
 * Controller, authorization and request-lifetime contracts remain in the component suite.
 */
async function setFixtureContent(page: Page, content: string) {
  await page.setContent(content.replace("<head>", '<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "person-profile-"));
  const configuration: import("vite").InlineConfig = {
    configFile: false,
    publicDir: false,
    logLevel: "error",
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      },
    }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/person-profile.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  };
  await build(configuration);
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
          : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  const modules = fs.readdirSync(outDir).filter(name => name.endsWith(".css"))
    .map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
  const { optimize } = await import("@tailwindcss/node");
  css = stripAppFontFaces(optimize(compiler.build([...candidates]) + modules, { minify: true }).code) + productFontStyle();
});

test.afterAll(() => { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); });

async function openFixture(page: Page, width: number, theme = "light") {
  await page.setViewportSize({ width, height: 900 });
  await setFixtureContent(page, `<html class="${theme}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Aarav Sharma" })).toBeVisible();
  await awaitProductFont(page);
}

const taskIds = ["request-files", "ask-about-files", "request-scope", "request-cards"];
async function boxes(page: Page) {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-id]")].map((el) => {
    const { top, bottom, left, right, width, height } = el.getBoundingClientRect();
    return [el.dataset.id!, { top, bottom, left, right, width, height }];
  })));
}

for (const width of [320, 393, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`v16 typography and actions fit ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await openFixture(page, width, theme);
      const geometry = await page.locator("[data-profile-fixture]").evaluate((root) => {
        const hero = root.firstElementChild!;
        const cover = hero.firstElementChild!;
        const avatar = hero.querySelector('[data-slot="avatar"]')!;
        const title = root.querySelector("h1")!;
        const section = root.querySelector("h2")!;
        const empty = [...root.querySelectorAll("section")].find(node => node.textContent === "Nothing shared yet")!;
        const style = (el: Element) => {
          const value = getComputedStyle(el);
          return { size: value.fontSize, line: value.lineHeight, weight: value.fontWeight, radius: value.borderRadius };
        };
        const rect = (el: Element) => {
          const { left, width, height, top, bottom } = el.getBoundingClientRect();
          return { left, width, height, top, bottom };
        };
        return { title: style(title), section: style(section), hero: style(hero), cover: rect(cover), avatar: rect(avatar),
          empty: rect(empty), shell: rect(root.parentElement!), heroBox: rect(hero), titleBox: rect(title),
          historyTitle: rect(root.querySelector('[class*="historyTitle"]')!),
          pagination: style(root.querySelector('[class*="pagination"] > span')!),
          search: style(root.querySelector('input[placeholder="Search categories"]')!) };
      });
      expect(geometry.title).toMatchObject({ size: width < 768 ? "24px" : "28px", line: width < 768 ? "32px" : "36px", weight: "600" });
      expect(geometry.section).toMatchObject({ size: width < 768 ? "17px" : "20px", line: width < 768 ? "25px" : "28px", weight: "600" });
      expect(geometry.search.size).toBe(width < 768 ? "16px" : "14px");
      expect(geometry.hero.radius).toBe(width < 768 ? "20px" : "24px");
      expect(geometry.cover.height).toBe(width < 768 ? 94 : 120);
      expect(geometry.avatar.width).toBe(width < 768 ? 64 : 76);
      expect(geometry.cover.bottom - geometry.avatar.top).toBe(width < 768 ? 24 : 30);
      expect(geometry.titleBox.left - geometry.heroBox.left).toBe(width < 768 ? 17 : 25);
      expect(geometry.empty.height).toBe(width < 768 ? 62 : 68);
      expect(geometry.historyTitle.width).toBeGreaterThanOrEqual(160);
      expect(geometry.historyTitle.height).toBeLessThanOrEqual(40);
      expect(geometry.pagination).toMatchObject({ size: "12px", line: "18px" });
      expect(geometry.shell.width).toBeLessThanOrEqual(880);
      const rect = await boxes(page);
      expect(rect.request.height).toBe(44);
      expect(rect.share.height).toBe(44);
      expect(Math.abs(rect.request.top - rect.share.top)).toBeLessThan(1);
      for (const id of taskIds) {
        expect(rect[id].height).toBeGreaterThanOrEqual(60);
        expect(rect[id].width).toBeCloseTo(rect[taskIds[0]].width, 0);
        const task = await page.locator(`[data-id="${id}"]`).evaluate(el => ({
          radius: getComputedStyle(el).borderRadius,
          size: getComputedStyle(el).fontSize,
          icon: el.querySelector('[data-tone] svg')!.getBoundingClientRect().width,
        }));
        expect(task.radius).toBe("14px");
        expect(task.size).toBe(width >= 768 && width < 1024 ? "13px" : "12px");
        expect(task.icon).toBe(17);
      }
      expect(Math.abs(rect[taskIds[0]].top - rect[taskIds[1]].top)).toBeLessThan(1);
      if (width >= 1024) expect(Math.abs(rect[taskIds[0]].top - rect[taskIds[3]].top)).toBeLessThan(1);
      else expect(rect[taskIds[2]].top).toBeGreaterThanOrEqual(rect[taskIds[0]].bottom);
      expect(rect.manage.top).toBeGreaterThanOrEqual(rect[taskIds[3]].bottom);
      expect(rect.manage.height).toBeGreaterThanOrEqual(44);
      expect(rect.review.height).toBe(44);
      expect(rect.review.width).toBeLessThan(250);
      expect(await page.locator('[data-id="review"]').evaluate(el => getComputedStyle(el.parentElement!).position)).toBe("static");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if ([393, 1440].includes(width) && theme === "light") await page.screenshot({ path: testInfo.outputPath("profile-v16.png") });
      await page.locator('[data-id="review"]').scrollIntoViewIfNeeded();
      await expect(page.locator('[data-id="review"]')).toBeInViewport();
      if (width === 393 && theme === "light") await page.screenshot({ path: testInfo.outputPath("profile-v16-lower.png") });
    });
  }
}

test("long mixed-direction details, sparse actions and focus remain usable at 320px", async ({ page, browserName }) => {
  await openFixture(page, 320);
  await page.locator("h1").evaluate(el => { el.textContent = "Alexandria-Rose Sharma — عائشة الأحمد"; });
  await page.locator('a[href^="mailto:"] span').evaluate(el => { el.textContent = "alexandria.rose.extended@example.test"; });
  await page.locator('[data-id="request-cards"] [data-tone] > span:nth-child(2)').evaluate(el => { el.textContent = "Card request sent — طلب مشاركة البطاقة"; });
  await page.locator('[data-id="request-files"], [data-id="ask-about-files"]').evaluateAll(elements => elements.forEach(el => el.remove()));
  let rect = await boxes(page);
  expect(Math.abs(rect["request-scope"].top - rect["request-cards"].top)).toBeLessThan(1);
  expect(rect.manage.top).toBeGreaterThanOrEqual(rect["request-cards"].bottom);
  expect(await page.locator('[data-id="request-cards"]').evaluate(el => {
    const label = el.querySelector('[data-tone] > span:nth-child(2)')!;
    const range = document.createRange(); range.selectNodeContents(label);
    const text = range.getBoundingClientRect(), card = el.getBoundingClientRect();
    return text.left >= card.left && text.right <= card.right && text.bottom <= card.bottom;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // WebKit's macOS full keyboard access uses Option+Tab to include buttons.
  for (let i = 0; i < 6; i++) await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  const question = page.getByRole("button", { name: "Ask a question", exact: true });
  await expect(question).toBeFocused();
  expect(await question.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
  await page.locator('[data-id="share"]').evaluate(el => {
    el.parentElement!.setAttribute("data-share-only", "true");
    el.parentElement!.querySelector('[data-id="request"]')!.remove();
  });
  rect = await boxes(page);
  expect(rect.share.width).toBeCloseTo(await page.locator('[data-id="share"]').evaluate(el => el.parentElement!.getBoundingClientRect().width), 0);
});
