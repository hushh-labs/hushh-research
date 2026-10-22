import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Render actual controls with production CSS. Only catalog/network and native
// presentation ports are fixtures: this is geometry/input proof, not relay acceptance.
let script: string;
let css: string;
test.use({ hasTouch: true });

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "puppy-controls-"));
  let moduleCss = "";
  try {
    await build({ configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic", development: false } },
      plugins: [{ name: "fixture-css", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      } }], resolve: { alias: [
        ...["@/lib/capacitor/native-navigation", "@/lib/capacitor/native-presentation-regions", "@/components/app-ui/native-chat-chrome"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/files-move-boundaries.tsx") })),
        { find: /^\.\/files-(?:settings-panel|organization-history)$/, replacement: path.join(root, "e2e/fixtures/files-move-boundaries.tsx") },
        ...["@/lib/hermes/local-host", "@/lib/hermes/use-puppy-link", "@/lib/services/puppy-one-service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/puppy-machine-boundary.ts") })),
        { find: "@/lib/agent/use-puppy-catalog", replacement: path.join(root, "e2e/fixtures/puppy-catalog-boundary.ts") },
        { find: "@", replacement: root },
      ] }, define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      build: { outDir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/puppy-chat-controls.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    for (const file of fs.readdirSync(outDir).filter((file) => file.endsWith(".css"))) moduleCss += fs.readFileSync(path.join(outDir, file), "utf8");
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"), loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...candidates])) + moduleCss + productFontStyle();
});

for (const width of [320, 390, 768, 1280]) {
 for (const variant of width === 320 || width === 1280 ? ["remote", "expired", "local"] : ["remote", "expired"]) {
  const expired = variant === "expired";
  test(`Puppy ribbon and One-style composer stay aligned and usable at ${width}px${variant === "remote" ? "" : ` with ${variant} controls`}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("Puppy fixture:", error.message); });
    await page.goto(`about:blank${variant === "remote" ? "" : `#${variant}`}`);
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    const ribbon = page.getByRole("group", { name: "Puppy controls" });
    const composer = page.getByTestId("puppy-chat-composer");
    await expect(ribbon, errors.join("\n")).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(page.getByRole("button", { name: "Talk to One" })).toBeHidden();
    await expect(page.locator("[data-agent-dock-composer]").getByRole("textbox", { name: "Message Puppy One" })).toBeVisible();
    await awaitProductFont(page);
    if (expired) await expect(page.getByText(/This machine is signed out/)).toBeVisible();
    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const node = document.querySelector(selector)!;
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
      };
      const composerStyle = getComputedStyle(document.querySelector('[data-testid="puppy-chat-composer"]')!);
      const compactHeight = 44 + ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce((sum, key) => sum + Number.parseFloat(composerStyle[key as keyof CSSStyleDeclaration] as string), 0);
      return { compactHeight, ribbon: bounds("[data-puppy-controls]"), composer: bounds('[data-testid="puppy-chat-composer"]'),
        controls: Array.from(document.querySelectorAll("[data-puppy-controls] button")).map(node => {
          const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
        }), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(Math.abs(geometry.ribbon.left - geometry.composer.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.ribbon.right - geometry.composer.right)).toBeLessThanOrEqual(1);
    // Shared 44px field and padding; WebKit may resolve borders to half pixels.
    expect(geometry.composer.height).toBeCloseTo(geometry.compactHeight, 0);
    expect(geometry.overflow).toBe(false);
    for (const control of geometry.controls) {
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.left).toBeGreaterThanOrEqual(geometry.ribbon.left - 1);
      expect(control.right).toBeLessThanOrEqual(geometry.ribbon.right + 1);
    }
    // A wrapped local pin must not vertically displace the machine trigger.
    expect(Math.abs(geometry.controls[0].top - geometry.controls.at(-1)!.top), JSON.stringify(geometry.controls)).toBeLessThanOrEqual(1);
    // Top-align both grid tracks even with inherited leading; centering only
    // the model produced the cross-platform 1.5px displacement.
    await ribbon.evaluate(node => { node.style.lineHeight = "48px"; });
    const leadingOffset = await ribbon.evaluate(node => {
      const buttons = Array.from(node.querySelectorAll("button"));
      return Math.abs(buttons[0].getBoundingClientRect().top - buttons.at(-1)!.getBoundingClientRect().top);
    });
    expect(leadingOffset).toBeLessThanOrEqual(1);
    await ribbon.evaluate(node => { node.style.removeProperty("line-height"); });
    const before = await ribbon.boundingBox();
    await page.getByTestId("transcript").evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect(await ribbon.boundingBox()).toEqual(before);
    await page.getByRole("button", { name: "This machine", exact: true }).tap();
    const machine = page.getByRole("dialog");
    await expect(machine).toBeVisible();
    await expect(machine.getByRole("heading", { name: "This machine", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(machine).toBeHidden();
    const input = page.getByRole("textbox", { name: "Message Puppy One" });
    await input.fill("Synthetic Puppy question");
    await input.press("Enter");
    await expect(page.getByTestId("sent-count")).toHaveText("1");
    await expect(input).toHaveValue("");
    const pacing = await page.evaluate(() => window.__hushhPerf?.snapshot());
    expect(pacing?.tick_errors).toBe(0);
    const pacingPath = info.outputPath("frame-pacing.json");
    fs.writeFileSync(pacingPath, JSON.stringify(pacing, null, 2));
    await info.attach("frame-pacing", { path: pacingPath, contentType: "application/json" });
    await info.attach("geometry", { body: JSON.stringify({ width, ...geometry }), contentType: "application/json" });
    await page.evaluate(({ left, right }) => {
      for (const x of [left, right]) {
        const line = document.createElement("div");
        line.style.cssText = `position:fixed;inset:0 auto 0 ${x}px;width:1px;background:magenta;pointer-events:none;z-index:9999`;
        document.body.append(line);
      }
    }, geometry.ribbon);
    const screenshot = info.outputPath(`Puppy-${width}px-grid.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(`Puppy-${width}px-grid`, { path: screenshot, contentType: "image/png" });
  });
}

}
