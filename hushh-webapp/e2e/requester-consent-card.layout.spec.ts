import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The requester's living consent card (contracts C1, C3, C4) in a real
 * browser: every state renders inside the phone and desktop chat columns
 * without overflow, the live pulse honours reduced motion, and shared details
 * never show memory ids. Set REQUESTER_CARD_SHOT_DIR to also capture one
 * screenshot per state.
 */
let script: string;
let css: string;

const PERSON = "1234567890abcdef";
const ASKED = "2026-09-28T13:49:00Z";
const ENDS = "2026-10-05T12:00:00Z";
const STATES = ["ask", "broad-ask", "waiting", "reading", "answered", "partial", "declined", "access-ended", "no-progress", "shared-details"];

type Status = "pending" | "granted" | "denied" | "revoked";
function bundle(bundleId: string, items: Array<[string, Status]>, progress: Record<string, unknown> | null) {
  return {
    personRef: PERSON, bundleId, purpose: "Picking a place for our dinner together", durationSeconds: 168 * 3600, cancelled: false,
    items: items.map(([label, status], index) => ({ requestId: `${bundleId}_r${index + 1}`, scopeRef: `scope-${index}`, label, sensitivity: "standard", status })),
    ...(progress ? { progress: { requested_at: ASKED, ...progress,
      fields: items.map(([label, status]) => ({ scope: `attr.${label}`, label, status })) } } : {}),
  };
}
const decided = { delivered_at: ASKED, seen_at: ASKED, decided_at: ASKED };
const BUNDLES: Record<string, unknown> = {
  bundle_waiting01: bundle("bundle_waiting01", [["Food preferences", "pending"]], { delivered_at: ASKED, seen_at: null, decided_at: null, outcome: "pending" }),
  bundle_reading01: bundle("bundle_reading01", [["Food preferences", "granted"]], { ...decided, outcome: "granted", access_ends_at: ENDS }),
  bundle_answered1: bundle("bundle_answered1", [["Food preferences", "granted"]], { ...decided, outcome: "granted", access_ends_at: ENDS }),
  bundle_partial01: bundle("bundle_partial01", [["Food preferences", "granted"], ["Health notes", "denied"]], { ...decided, outcome: "partially_granted", access_ends_at: ENDS }),
  bundle_declined1: bundle("bundle_declined1", [["Food preferences", "denied"]], { ...decided, outcome: "denied" }),
  bundle_revoked01: bundle("bundle_revoked01", [["Food preferences", "revoked"]], { ...decided, outcome: "revoked", ended_at: "2026-09-29T09:10:00Z" }),
  bundle_legacy001: bundle("bundle_legacy001", [["Food preferences", "pending"]], null),
};

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "requester-consent-card-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      },
    }],
    resolve: {
      alias: [
        ...["@/hooks/use-auth", "@/lib/vault/vault-context", "@/lib/services/api-service", "@/lib/services/auth-service",
          "@/lib/cache/cache-sync-service", "@/lib/firebase/config", "next/link"].map((find) => ({
          find, replacement: path.join(root, "e2e/fixtures/requester-consent-card-boundaries.tsx"),
        })),
        { find: "@", replacement: root },
      ],
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/requester-consent-card.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

for (const [width, height] of [[393, 852], [1440, 900]] as const)
  test(`requester consent card states fit and stay calm at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://localhost/requester-consent-card", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.route("**/api/one/information-requests/*", (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop()!;
      const body = BUNDLES[id];
      return body ? route.fulfill({ contentType: "application/json", body: JSON.stringify(body) }) : route.fulfill({ status: 404, body: "{}" });
    });
    await page.route(`**/api/one/people/${PERSON}/scope-catalog*`, (route) => {
      const query = new URL(route.request().url()).searchParams.get("query") ?? "";
      // A label search for the broad ask returns it with its place and what it covers.
      const scopes = query.startsWith("Food") ? [
        { scopeRef: "scope-food-all", label: "Food & dining information", domain: "food", wildcard: true, pathSegments: [] },
        { scopeRef: "scope-food-prefs", label: "Food preferences", domain: "food", wildcard: true, pathSegments: ["preferences"] },
        { scopeRef: "scope-food-diet", label: "Dietary constraints", domain: "food", wildcard: false, pathSegments: ["dietary_constraints"] },
      ] : [{ scopeRef: "scope-food", label: "Food preferences", domain: "lifestyle" },
        { scopeRef: "scope-restaurants", label: "Favorite restaurants", domain: "lifestyle" }];
      return route.fulfill({ contentType: "application/json",
        body: JSON.stringify({ scopes, page: 1, has_more: false, total_count: scopes.length }) });
    });
    await page.route(`**/api/one/people/${PERSON}`, (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ personRef: PERSON, displayName: "Kushal Trivedi", photoUrl: null, verifiedRole: null,
        relationship: { status: "connected", connectionId: "c", connectedAt: null, requestId: null },
        grants: [], requestHistory: [], requestableScopes: [
          { scopeRef: "scope-food", label: "Food preferences", description: null, domain: "lifestyle", sensitivity: "standard", wildcard: false },
        ] }),
    }));
    await page.goto("http://localhost/requester-consent-card");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);

    await expect(page.locator("[data-state='waiting'] [data-testid='request-timeline']")).toBeVisible();
    await expect(page.locator("[data-state='no-progress']")).toContainText("Waiting for Kushal Trivedi's approval");
    await expect(page.locator("[data-state='no-progress'] [data-testid='request-timeline']")).toHaveCount(0);
    await expect(page.locator("[data-state='reading']")).toContainText("Reading what Kushal shared…");
    await expect(page.locator("[data-state='partial']")).toContainText("Access ends Oct 5");
    await expect(page.locator("[data-state='access-ended']"))
      .toContainText("Kushal stopped sharing Food preferences. One no longer uses it.");
    const ask = page.locator("[data-state='ask']");
    await expect(ask.getByTestId("ask-sentence")).toHaveText("Ask Kushal for Food preferences · 7 days");
    await expect(ask.getByTestId("ask-reason")).toHaveText("To plan dinner together");
    await expect(ask.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    // A2: the broad ask is one group over what it covers, tri-state, and the
    // summary follows the choice.
    const broad = page.locator("[data-state='broad-ask']");
    const group = broad.getByRole("checkbox", { name: "Food & dining information" });
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await expect(broad.getByTestId("ask-proposal-row")).toHaveCount(1);
    await expect(group).toHaveAttribute("aria-checked", "true");
    await expect(broad.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await broad.getByRole("button", { name: "Show what Food & dining information includes" }).click();
    await broad.getByRole("checkbox", { name: "Dietary constraints" }).click();
    await expect(group).toHaveAttribute("aria-checked", "mixed");
    await expect(broad.getByTestId("ask-proposal-summary")).toHaveText("1 item · 7 days");
    for (const row of await broad.getByTestId("ask-proposal-row").all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    const details = page.locator("[data-state='shared-details']");
    await expect(details).toContainText("Nopa");
    expect(await details.textContent()).not.toMatch(/mem[\s_-]?65725402299c|\bkind\b|\bstatus\b|entities|_items|manifest|\b2\b/i);
    // The envelope's source domain ("food") is bookkeeping; the heading "Food preferences" is not.
    expect(await details.textContent()).not.toMatch(/\bfood\b/);

    for (const state of STATES) {
      const section = page.locator(`[data-state='${state}']`);
      await section.scrollIntoViewIfNeeded();
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${state} overflows`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // The live pulse moves only when motion is welcome.
    const pulse = page.locator("[data-state='waiting'] [data-testid='timeline-pulse']");
    expect(await pulse.evaluate((node) => getComputedStyle(node).animationName)).not.toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await pulse.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");

    const shotDir = process.env.REQUESTER_CARD_SHOT_DIR;
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      for (const state of STATES) {
        await page.locator(`[data-state='${state}']`).screenshot({ path: path.join(shotDir, `requester-card-${state}-${width}.png`), animations: "disabled" });
      }
      await page.locator("[data-state='ask']").getByRole("button", { name: "Change" }).click();
      await expect(page.getByRole("button", { name: "Favorite restaurants" })).toBeVisible();
      await page.locator("[data-state='ask']").screenshot({ path: path.join(shotDir, `requester-card-ask-change-${width}.png`), animations: "disabled" });
    }
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(errors).toEqual([]);
  });
