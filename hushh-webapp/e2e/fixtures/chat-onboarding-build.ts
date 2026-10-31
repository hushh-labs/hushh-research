import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productFontStyle, stripAppFontFaces } from "./product-font";

async function buildScript(root: string, outDir: string) {
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }]))
              candidates.add(candidate);
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [
      ...["@/hooks/use-auth", "@/lib/vault/vault-context", "@/lib/services/pre-vault-user-state-service",
        "@/lib/pkm/use-live-mirror-view",
        "@/lib/services/personal-knowledge-model-service", "@/lib/services/api-service",
        "@/lib/services/pkm-upgrade-orchestrator", "@/lib/services/pkm-upgrade-service"].map(find => ({
          find, replacement: path.join(root, "e2e/fixtures/onboarding-name-boundaries.ts"),
        })),
      { find: "@", replacement: root },
    ] },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/chat-onboarding.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  return { script, candidates };
}

async function buildStyles(root: string, candidates: Set<string>) {
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
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  return stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
}

export async function buildChatOnboardingFixture(root: string) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const outDir = fs.mkdtempSync(path.join(tempRoot, "chat-onboarding-"));
  try {
    const { script, candidates } = await buildScript(root, outDir);
    return { script, css: await buildStyles(root, candidates) };
  } finally {
    const target = fs.realpathSync(outDir);
    if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith("chat-onboarding-")) {
      throw new Error("Fixture cleanup escaped its temporary directory");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
}
