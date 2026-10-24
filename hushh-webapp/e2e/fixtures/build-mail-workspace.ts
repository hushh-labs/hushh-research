import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { productFontStyle, stripAppFontFaces } from "./product-font";

export async function buildMailWorkspaceFixture() {
  let script: string;
  let css: string;
  let fixtureDir: string;
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-workspace-"));
  fixtureDir = outDir;
  const boundaries = path.join(root, "e2e/fixtures/mail-workspace-boundaries.tsx");
    const stubbed = ['next/navigation', '@/lib/consent/use-consent-pending-summary-count', '@/lib/feed/use-feed-unread-count', '@/lib/firebase/config', '@/lib/firebase/auth-context', '@/hooks/use-auth', '@/lib/vault/vault-context', '@/hooks/use-effective-avatar-url', '@/lib/persona/persona-context', '@/lib/capacitor/native-presentation-regions', '@/lib/services/vault-service', '@/lib/flows/delete-account', '@/lib/profile/gmail-connector-store', '@/lib/kai/actions/voice-surface-metadata', '@/lib/agent/local-onboarding-actions', '@/lib/capacitor', '@/lib/services/pre-vault-user-state-service', '@/lib/services/kyc-identity-profile-pkm-service', '@/lib/services/gmail-information-requests-service', '@/components/vault/vault-unlock-dialog', '@/lib/services/api-service'];
    const receiptResource = path.join(root, 'e2e/fixtures/mail-receipt-resource.ts');
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      { name: "relative-boundaries", resolveId(source, importer) {
        if (!importer || !source.startsWith(".")) return;
        const candidate = path.resolve(path.dirname(importer), source).replace(/\.(tsx?|jsx?)$/, "");
        if (stubbed.some(value => value.startsWith("@/") && path.join(root, value.slice(2)) === candidate)) return boundaries;
      } },
      {
        // Candidates are derived from every transformed module, so a class the
        // card renders cannot be missing from the CSS. A hand-maintained list
        // would let an unregistered class emit no style and still pass.
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
        ...stubbed.map(find => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: boundaries })),
        { find: '@/lib/services/mail-receipt-resource-service', replacement: receiptResource },
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      copyPublicDir: false,
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/mail-workspace.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
  css += fs.readdirSync(outDir).filter(file => file.endsWith(".css"))
    .map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
  const { transform } = await import("lightningcss");
  css = transform({ filename: "mail-workspace.css", code: Buffer.from(css), minify: true }).code.toString();
  return {
    script,
    css,
    dispose: () => fs.rmSync(fixtureDir, { recursive: true, force: true }),
  };
}
