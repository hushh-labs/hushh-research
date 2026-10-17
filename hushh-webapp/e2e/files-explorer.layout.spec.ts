import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let script: string;
let css: string;
test.use({ hasTouch: true });

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-move-"));
  let moduleCss = "";
  try {
    await build({ configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic", development: false } },
      plugins: [{ name: "fixture-css", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      } }], resolve: { alias: [
        ...["@/lib/files/service", "@/lib/capacitor/native-navigation", "@/lib/capacitor/native-presentation-regions", "@/components/app-ui/native-chat-chrome"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/files-move-boundaries.tsx") })),
        { find: /^\.\/files-(?:settings-panel|organization-history)$/, replacement: path.join(root, "e2e/fixtures/files-move-boundaries.tsx") },
        { find: "@", replacement: root },
      ] }, define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      build: { outDir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/files-move.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
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

for (const width of [390, 1280]) {
  test(`Move survives menu focus return and commits only the chosen folder at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    const actions = page.getByRole("button", { name: "File actions", exact: true });
    const activate = (target: import("@playwright/test").Locator) => width < 768 ? target.tap() : target.click();
    const open = async () => {
      await activate(actions);
      await activate(page.getByRole(width < 768 ? "button" : "menuitem", { name: "Move", exact: true }));
      const dialog = page.getByRole("dialog", { name: "Move notes.txt", exact: true });
      await expect(dialog.getByRole("button", { name: "Open Documents", exact: true })).toBeVisible();
      // Pointer movement after selection reproduced the deployed focus race.
      await page.mouse.move(0, 0);
      await expect(dialog).toBeVisible();
      return dialog;
    };
    let dialog = await open();
    await expect(dialog.getByRole("button", { name: "Move here", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("saved-destination")).toHaveText("");
    dialog = await open();
    await activate(dialog.getByRole("button", { name: "Open Documents", exact: true }));
    await activate(dialog.getByRole("button", { name: "Move here", exact: true }));
    await expect(page.getByTestId("saved-destination")).toHaveText("destination");
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
