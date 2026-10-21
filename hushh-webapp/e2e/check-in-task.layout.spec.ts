import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";
const STUBBED = ["next/navigation", "@/lib/one-location/service", "@/lib/one-location/location-grant-memory", "@/lib/one-location/saved-locations", "@/lib/one-location/visit-notes", "@/lib/observability/location-events", "@/lib/agent/local-onboarding-actions"];
let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-in-task-"));
  const boundaries = path.join(root, "e2e/fixtures/check-in-task-boundaries.tsx");
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
        entry: path.join(root, "e2e/fixtures/check-in-task.tsx"),
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
  css = transform({ filename: "check-in-task.css", code: Buffer.from(css), minify: true }).code.toString();
});


for (const width of [320, 393, 1024]) {
  test(`Check-in tasks use the shared sizing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
    await awaitProductFont(page);
    await page.addScriptTag({ content: script });
    const panel = page.getByTestId("one-location-nearby-check-in-sheet");
    await expect(panel.getByRole("heading", { name: "Check in nearby", exact: true })).toHaveCSS("font-size", "20px");
    await expect(panel.getByRole("heading", { name: "Check in nearby", exact: true })).toHaveCSS("line-height", "28px");
    await expect(panel.getByRole("heading", { name: "Checked in", exact: true })).toHaveCSS("font-size", "17px");
    const leaving = panel.getByRole("button", { name: "I'm leaving", exact: true });
    await expect(leaving).toHaveCSS("height", "44px");
    await expect(leaving).toHaveCSS("font-size", "13px");
    await expect(leaving).toHaveCSS("line-height", "20px");
    const venue = panel.getByText("A long test venue name, Building Nine, Riverside Business Centre");
    await expect(venue).toHaveCSS("white-space", "normal");
    const contained = await venue.evaluate(node => {
      const panel = node.closest('[data-testid="one-location-nearby-check-in-sheet"]')!;
      return node.getBoundingClientRect().right <= panel.getBoundingClientRect().right;
    });
    expect(contained).toBe(true);
    await panel.getByRole("button", { name: "Add time", exact: true }).click();
    const more = page.getByRole("button", { name: "30 min more", exact: true });
    const extension = page.getByRole("heading", { name: "Add time", exact: true });
    await expect(extension).toHaveCSS("font-size", "20px");
    await expect(extension).toHaveCSS("line-height", "28px");
    await expect(more).toHaveCSS("height", "44px");
    await expect(more).toHaveCSS("font-size", "13px");
    await more.click();
    await expect(page.locator("body")).toHaveAttribute("data-extended", "true");
    await expect(extension).toBeHidden();
    await expect(panel.getByRole("heading", { name: "Checked in", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`check-in-task-${width}.png`), animations: "disabled" });
  });
}
