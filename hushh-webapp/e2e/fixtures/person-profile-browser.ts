import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InlineConfig } from "vite";
import { productFontStyle, stripAppFontFaces } from "./product-font";

export type PersonProfileBrowserFixture = {
  css: string;
  script: string;
  requestScript: string;
  previewScript?: string;
  dispose(): void;
};

/** Shared production presentation/request fixture compiler. Each browser worker
 * owns its temporary output; failed builds and completed packs both remove it.
 */
export async function buildPersonProfileBrowserFixture({ includePresentation = true, includePreview = false } = {}): Promise<PersonProfileBrowserFixture> {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "person-profile-"));
  const dispose = () => fs.rmSync(outDir, { recursive: true, force: true });
  const buildFixture = async (entry: string, fileName: string, resolve: InlineConfig["resolve"]) => {
    await build({
      configFile: false, publicDir: false, logLevel: "error",
      plugins: [{ name: "fixture-css-candidates", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      } }],
      oxc: { jsx: { runtime: "automatic", development: false } },
      define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      resolve,
      build: { outDir, emptyOutDir: false, lib: {
        entry: path.join(root, "e2e/fixtures", entry), name: "Fixture", formats: ["iife"], fileName: () => fileName,
      } },
    });
    return fs.readFileSync(path.join(outDir, fileName), "utf8");
  };
  try {
    const script = includePresentation
      ? await buildFixture("person-profile.tsx", "fixture.js", { alias: [{ find: "@", replacement: root }] }) : "";
    const ports = path.join(root, "e2e/fixtures/person-profile-request-ports.tsx");
    const boundaries = ["hooks/use-auth", "lib/vault/vault-context", "lib/services/auth-service", "lib/services/api-service", "lib/cache/cache-sync-service", "lib/one-location/key-bootstrap", "components/vault/vault-flow"];
    const requestScript = await buildFixture("person-profile-requests.tsx", "request-fixture.js", { alias: [
      ...boundaries.map(name => ({ find: `@/${name}`, replacement: ports })),
      { find: "next/navigation", replacement: ports },
      { find: /^\.\/auth-service$/, replacement: ports },
      { find: /^\.\/api-service$/, replacement: ports },
      { find: "@", replacement: root },
    ] });
    const { compile } = await import("tailwindcss");
    const previewPorts = path.join(root, "e2e/fixtures/person-profile-preview-ports.tsx");
    const previewScript = includePreview ? await buildFixture("person-profile-preview.tsx", "preview-fixture.js", { alias: [
      { find: "@/hooks/use-auth", replacement: previewPorts },
      { find: "@/lib/services/connections-service", replacement: previewPorts },
      { find: "next/navigation", replacement: previewPorts },
      { find: /^\.\/person-profile-page$/, replacement: previewPorts },
      { find: "@", replacement: root },
    ] }) : undefined;
    const compiler = await compile(
      fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
      {
        base: path.join(root, "app"),
        loadStylesheet: async (id, base) => {
          const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
          return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
        },
      },
    );
    const modules = fs.readdirSync(outDir).filter(name => name.endsWith(".css"))
      .map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
    const { optimize } = await import("@tailwindcss/node");
    const css = stripAppFontFaces(optimize(compiler.build([...candidates]) + modules, { minify: true }).code) + productFontStyle();
    return { css, script, requestScript, previewScript, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
