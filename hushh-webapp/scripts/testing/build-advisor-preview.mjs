/** Build the real recommendation UI with synthetic boundaries for local review. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { Scanner } from "@tailwindcss/oxide";
import { compile } from "tailwindcss";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(root, "../tmp/advisor-preview");
const scanner = new Scanner({});
const candidates = new Set();
await fs.mkdir(output, { recursive: true });
await build({
  configFile: false, logLevel: "error", publicDir: false,
  plugins: [{ name: "preview-class-names", transform(source, id) {
    if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
      for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
  } }],
  oxc: { jsx: { runtime: "automatic", development: false } },
  resolve: { alias: [
    ...["@/lib/advisor-review/service", "@/lib/advisor-review/snapshot", "@/lib/services/kai-profile-service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/advisor-review-boundaries.ts") })),
    { find: "@/lib/services/finance-sharing-service", replacement: path.join(root, "e2e/fixtures/finance-sharing-boundaries.ts") },
    { find: /^next\/navigation$/, replacement: path.join(root, "e2e/fixtures/agent-markdown-boundaries.ts") },
    { find: "@", replacement: root },
  ] },
  define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
  build: { outDir: output, emptyOutDir: false,
    lib: { entry: path.join(root, "e2e/fixtures/advisor-recommendation-preview.tsx"), name: "AdvisorPreview", formats: ["iife"], fileName: () => "preview.js" },
  },
});
const compiler = await compile((await fs.readFile(path.join(root, "app/globals.css"), "utf8")).replace(/^@source\s+[^;]+;\s*$/gm, ""), {
  base: path.join(root, "app"),
  loadStylesheet: async (id, base) => {
    const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
      : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
    return { path: file, base: path.dirname(file), content: await fs.readFile(file, "utf8") };
  },
});
let css = compiler.build([...candidates]).replace(/@font-face\s*\{[^}]*url\([^)]*\/fonts\/[^)]*\)[^}]*\}/g, "");
for (const weight of [400, 600, 700]) {
  const font = await fs.readFile(path.join(root, `public/fonts/PlusJakartaSans/plus-jakarta-sans-latin-${weight}-normal.woff2`));
  css += `@font-face{font-family:'Plus Jakarta Sans';src:url(data:font/woff2;base64,${font.toString("base64")}) format('woff2');font-weight:${weight};font-display:block}`;
}
for (const file of await fs.readdir(output)) if (file.endsWith(".css") && file !== "preview.css") css += await fs.readFile(path.join(output, file), "utf8");
await fs.writeFile(path.join(output, "preview.css"), css);
await fs.writeFile(path.join(output, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Advisor matching prototype</title><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script src="preview.js"></script></body></html>');
const sampleServices = ["Portfolio Management", "Portfolio Management · Retirement Planning", "Tax Planning", "Estate Planning", "Retirement Planning"];
for (let index = 1; index <= sampleServices.length; index++) {
  const digit = String(index);
  const personRef = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const directory = path.join(output, "people", personRef);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample advisor profile</title><link rel="stylesheet" href="/preview.css"></head><body><main class="mx-auto flex max-w-xl flex-col gap-6 px-5 py-8"><a class="ui-text-trailing-action" href="/">Back to advisor preview</a><header><p class="ui-text-helper-text">Sample profile</p><h1 class="ui-text-page-title">Sample matching advisor ${index}</h1></header><section><h2 class="ui-text-section-label">Services offered</h2><p class="ui-text-row-description">${sampleServices[index - 1]}</p></section><p class="ui-text-helper-text">This fictional profile demonstrates service matching. No real advisor or regulatory record is represented.</p></main></body></html>`);
}
console.log(`Preview built: ${path.join(output, "index.html")}`);
console.log("Serve the preview directory on localhost. All profiles and transport are synthetic.");
