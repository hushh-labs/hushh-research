import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * Isolated-fixture render of the real ReferralsPanel (PR4 gamification UI).
 *
 * No Next.js app shell, no real backend: Vite bundles the actual
 * `components/profile/referrals-panel.tsx` source. `@/lib/firebase/auth-context`
 * is swapped for a fixture stub (see
 * e2e/fixtures/referrals-panel-gamification.auth-stub.tsx) so the component
 * renders as a signed-in viewer without a real session. ReferralsPanel's own
 * transitive imports (ApiService -> AuthService -> lib/firebase/config) reach
 * the REAL Firebase SDK too, independently of auth-context -- that module
 * calls `getAuth()` at import time, which throws synchronously on an empty
 * `NEXT_PUBLIC_FIREBASE_API_KEY` (the real local blocker this harness exists
 * to route around). Rather than stub every file that transitively touches
 * Firebase, this build `define`s a syntactically well-formed but entirely
 * fake API key: `getAuth()` only validates the key's presence/shape at
 * import time, never calls out to Google, so this is enough to let import
 * eval succeed without a real credential, while ReferralsPanel's actual
 * auth state still comes only from the stub above. Every
 * `/api/one/referrals/*` call is intercepted and answered with payloads
 * shaped exactly like the real response types in
 * `lib/services/referral-service.ts`. This proves the component renders and
 * reads real contract shapes correctly; it does NOT prove the live backend
 * integration, which stays separately blocked (see PR4 report).
 */

let script: string;
let css: string;
let fixtureDir: string | undefined;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "referrals-panel-gamification-"));
  fixtureDir = outDir;

  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        // Vite 8 auto-resolves tsconfig.json's "@/*" paths mapping
        // internally for any importer inside tsconfig's `include`, ahead of
        // user-supplied `resolve.alias` entries and even an `enforce: "pre"`
        // resolveId hook keyed on the original "@/..." specifier text --
        // both lose that race. A `load` hook keyed on the fully RESOLVED
        // absolute path runs after resolution has already settled on one
        // real file on disk, so it intercepts regardless of which resolver
        // got there first.
        name: "fixture-auth-context-override",
        enforce: "pre",
        load(id: string) {
          const clean = path.normalize(id.split("?")[0]).toLowerCase();
          const authContext = path.normalize(path.join(root, "lib/firebase/auth-context.tsx")).toLowerCase();
          if (clean === path.normalize(path.join(root, "lib/services/api-service.ts")).toLowerCase()) {
            return `export { ApiService } from ${JSON.stringify(path.join(root, "e2e/fixtures/referrals-panel-gamification.auth-stub.tsx"))};`;
          }
          if (clean === authContext) {
            return fs.readFileSync(
              path.join(root, "e2e/fixtures/referrals-panel-gamification.auth-stub.tsx"),
              "utf8",
            );
          }
          return null;
        },
      },
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }]))
              candidates.add(candidate);
        },
      },
    ],
    resolve: {
      alias: [{ find: "@", replacement: root }],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      // A syntactically well-formed but fake key: enough for getAuth()'s
      // import-time presence/shape check to pass without a real credential
      // (see the file-header comment). Never a real project value.
      "process.env.NEXT_PUBLIC_FIREBASE_API_KEY": JSON.stringify("AIzaSyFixtureFixtureFixtureFixtureFixt"),
      "process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN": JSON.stringify("fixture.firebaseapp.com"),
      "process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID": JSON.stringify("fixture-project"),
      "process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET": JSON.stringify("fixture-project.appspot.com"),
      "process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID": JSON.stringify("000000000000"),
      "process.env.NEXT_PUBLIC_FIREBASE_APP_ID": JSON.stringify("1:000000000000:web:fixture"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/referrals-panel-gamification.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");

  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

/** Contract-matching fixture payloads -- shapes copied from the real
 * response types in lib/services/referral-service.ts. All values are
 * synthetic and clearly fictional (never real production scores). */
const FIXTURES: Record<string, unknown> = {
  "/api/one/referrals/summary": {
    slug: "fixture-slug",
    link: "https://one.hushh.ai/r/fixture-slug",
    joined_count: 7,
    total_count: 10,
    qualified_count: 7,
    in_progress_count: 2,
    under_review_count: 1,
    required_active_minutes: 30,
    new_users_only: true,
    referrals: [
      {
        status: "Qualified",
        step: "Completed setup",
        started_on: "2026-09-01",
        active_minutes: 30,
        required_minutes: 30,
        meaningful_events: 3,
        required_events: 3,
      },
      {
        status: "In progress",
        step: "Verifying phone",
        started_on: "2026-09-28",
        active_minutes: 12,
        required_minutes: 30,
        meaningful_events: 1,
        required_events: 3,
      },
    ],
  },
  "/api/one/referrals/leaderboard": {
    snapshot_generated_at: "2026-10-04T12:00:00Z",
    entries: [
      { rank: 1, handle: "fixture-top", display_name: "Alias owner profile", points: 420, is_viewer: false },
      { rank: 2, handle: "Anonymous referrer", display_name: "Fixture permitted member", points: 310, is_viewer: true },
      { rank: 3, handle: "Anonymous referrer", display_name: null, points: 290, is_viewer: false },
    ],
    viewer: { rank: 2, handle: "Anonymous referrer", display_name: "Fixture permitted member", points: 310, is_viewer: true },
    stale: false,
  },
  "/api/one/referrals/circles/leaderboard": {
    status: "preview", competition_active: false,
    teams: [

    ],
  },
  "/api/one/referrals/milestones": {
    joined_referral_count: 7,
    earned: [
      { milestone_key: "m5", reward: "Fixture reward tier 1", earned_at: "2026-09-15T00:00:00Z" },
    ],
    next_milestone: { milestone_key: "m10", threshold: 10, reward: "Fixture reward tier 2", progress: 7 },
  },
  "/api/one/referrals/engagement": {
    streak: { current_run_days: 3, run_length_days: 5 },
    flash: { active: true, ends_at: "2026-10-05T00:00:00Z" },
  },
  "/api/one/referrals/circle": { status: "preview", competition_active: false, circle_id: null, selected_at: null },
  "/api/one/referrals/points": { points: 310, coins: 310 },
  "/api/one/referrals/handle": { handle: "fixture-viewer" },
};

async function fulfillReferralsApi(route: Route) {
  const url = new URL(route.request().url());
  const match = Object.keys(FIXTURES).find((p) => url.pathname === p);
  if (!match) {
    await route.fulfill({ status: 404, body: "not mocked in fixture" });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(FIXTURES[match]),
  });
}

/**
 * Isolation guard: anything that is not our own intercepted fixture page or
 * our own intercepted `/api/one/referrals/*` fixture responses is a request
 * trying to leave the sandbox -- real Firebase, real Google, real shared
 * UAT. Registered FIRST, so the specific routes added after it in
 * `openFixture` win for the two patterns they match (Playwright gives the
 * LAST-registered matching route priority); everything else falls through
 * to this handler, which aborts it and records it as a violation instead of
 * letting it reach a real network destination.
 */
async function installIsolationGuard(page: Page, violations: string[]): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      host = "unknown";
    }
    // Only a non-localhost destination is the thing this guard exists to
    // catch (real Firebase, real Google, real shared UAT). An unmatched
    // LOCALHOST request (e.g. the browser's own favicon probe) is aborted
    // too -- nothing should reach a real listener -- but is not counted as
    // an isolation violation, since it was never going to leave the
    // sandbox.
    if (host !== "localhost") {
      violations.push(`${route.request().method()} ${url} (host=${host})`);
    }
    await route.abort("blockedbyclient");
  });
}

async function openFixture(
  page: Page,
  viewport: { width: number; height: number },
  violations: string[],
): Promise<void> {
  await page.setViewportSize(viewport);
  await installIsolationGuard(page, violations);
  await page.route("**/api/one/referrals/**", fulfillReferralsApi);
  await page.route("http://localhost/referrals-panel-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto("http://localhost/referrals-panel-fixture");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

for (const viewport of VIEWPORTS) {
  test(`renders the gamified Referrals panel from contract-matching fixtures (${viewport.name})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    const violations: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page, viewport, violations);

    await expect(page.getByTestId("referral-milestone-progress")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("#2 Fixture permitted member", { exact: true })).toBeVisible();
    await expect(page.getByText("#3 Name unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText(/Alias owner profile/)).toHaveCount(0);
    await expect(page.getByText(/Anonymous referrer/)).toHaveCount(0);

    // Circle standings are gated by the current published product contract.
    // The actual service rejects fabricated private-circle standings.
    await expect(page.getByText("Team leaderboard", { exact: true })).toHaveCount(0);

    await page.getByText("#2 Fixture permitted member", { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText("#2 Fixture permitted member", { exact: true })).toBeInViewport();
    const outDir = path.join(process.cwd(), "test-results", "fixture-screenshots");
    fs.mkdirSync(outDir, { recursive: true });
    await page.screenshot({
      path: path.join(outDir, `referrals-panel-gamification-${test.info().project.name}-${viewport.name}.png`),
      fullPage: false,
    });

    expect(errors).toEqual([]);
    // Zero tolerance: any request that reached a real host (Firebase,
    // Google, shared UAT, anything) fails the test outright.
    expect(violations).toEqual([]);
  });
}


test.afterAll(() => {
  if (!fixtureDir) return;
  const target = fs.realpathSync(fixtureDir);
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith("referrals-panel-gamification-")) {
    throw new Error("Unexpected referral fixture cleanup path");
  }
  fs.rmSync(target, { recursive: true, force: true });
  fixtureDir = undefined;
});
