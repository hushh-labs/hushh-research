import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./product-font";

// Render production components and styles; replace only device/map/telemetry
// and authentication boundaries. Handwritten card markup previously hid the reported regressions.
let fixtureCss: string;
let fixtureScript: string;

export async function buildOnboardingFixture() {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "location-onboarding-"));
  const stubs: Record<string, string> = {
    "@/lib/firebase/config": "export const app = {}; export const auth = { currentUser: null, settings: {} }; export const getRecaptchaVerifier = () => {}; export const prepareRecaptchaVerifier = async () => {}; export const resetRecaptcha = () => {};",
    "@/lib/one-location/use-google-maps": "export const useGoogleMaps = () => ({ status: 'error', isLoaded: false });",
    "@/lib/one-location/use-current-location": "export const useCurrentLocation = () => ({ snapshot: null });",
    "@/components/app-ui/native-test-beacon": "export const NativeTestBeacon = () => null;",
    "@/lib/observability/client": "export const trackEvent = () => {}; export const toDurationBucket = () => 'fast'; export const trackApiRequestCompleted = () => {}; export const trackCacheResourceResolved = () => {}; export const trackWarmupCompleted = () => {}; export const trackRouteReadinessCompleted = () => {}; export const trackRouteRefreshCompleted = () => {};",
    "@/lib/observability/growth": "export const trackLocationFunnelStepCompleted = () => {}; export const trackLocationActivationCompleted = () => {};",
  };
  try {
  await build({
    configFile: false, publicDir: false, logLevel: "error",
    plugins: [{
      name: "onboarding-boundaries",
      load(id) { return stubs[id.replace("\0", "")]; },
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      },
    }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [...Object.keys(stubs).map(find => ({ find, replacement: `\0${find}` })), { find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: { outDir, emptyOutDir: false, minify: false, lib: { entry: path.join(root, "e2e/fixtures/location-onboarding.tsx"), name: "OnboardingFixture", formats: ["iife"], fileName: () => "fixture.js" } },
  });
  fixtureScript = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  } finally {
    const script = path.join(outDir, "fixture.js");
    if (fs.existsSync(script)) fs.unlinkSync(script);
    fs.rmdirSync(outDir);
  }
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  fixtureCss = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
}

export async function openFixture(page: Page, { ready = false, dark = false, banner = false } = {}) {
  await page.goto("about:blank");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/one-location/onboarding/*.webp", route => route.fulfill({ contentType: "image/webp", body: fs.readFileSync(path.join("public/one-location/onboarding", path.basename(new URL(route.request().url()).pathname))) }));
  await page.route("**/one-location/onboarding/check-in-location-pin.svg", route => route.fulfill({ contentType: "image/svg+xml", body: fs.readFileSync("public/one-location/onboarding/check-in-location-pin.svg") }));
  await page.setContent(`<html class="${dark ? "dark" : ""}"><head><base href="http://fixture.invalid/"><style>${fixtureCss}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate(flags => { window.onboardingFixture = flags; }, { ready, banner });
  await page.addScriptTag({ content: fixtureScript });
  await expect.poll(() => errors.length ? errors : page.getByTestId(banner ? "saved-places-banner" : "one-location-onboarding").count()).toBe(1);
  await awaitProductFont(page);
}
