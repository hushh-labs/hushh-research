// Can a brand-new person reach the screen that asks where their agent should live?
//
// WHY THIS EXISTS AS A DRIVER RATHER THAN A DIAGNOSTIC
// The first version of this file printed what the browser saw and always exited 0.
// It was useful once and evidence never: a script that cannot fail cannot back a
// claim. The completion ledger's `receipt` checks require a reproduction path that
// somebody else can run and watch fail, so this exits non-zero when the cloud-tier
// choice does not render, and prints the fan-out measurement that explains why.
//
//   REVIEWER_UID=<uid> node hushh-webapp/scripts/testing/first-run-reachability.mjs
//
// Needs the local stack (proxy 6543, backend 8000, web 3000) and review mode on.
// Exit 0 = the choice screen rendered. Exit 1 = it did not, and the report says
// which requests were still outstanding when we gave up.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(HERE, "..", "..");
const ORIGIN = process.env.ONE_ORIGIN || "http://localhost:3000";
const UID = process.env.REVIEWER_UID;
const BUDGET_MS = Number(process.env.FIRST_RUN_BUDGET_MS || 60_000);

// The pool the first-paint fan-out runs against. Measured against this, not
// guessed: more concurrent DB-touching routes than connections is the mechanism
// behind the 125s call and the 503s, and it is the number to drive down.
const DB_POOL_MAX_SIZE = Number(process.env.DB_POOL_MAX_SIZE || 4);

if (!UID) {
  console.error("REVIEWER_UID is required: this drives a real reviewer session.");
  process.exit(2);
}

const { chromium } = createRequire(`${WEBAPP}/package.json`)("playwright");

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((u) => {
  window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true, expectedUserId: u };
}, UID);
const page = await ctx.newPage();

const noticed = [];
const failed = [];
page.on("console", (m) => {
  const t = m.text();
  if (/guard|admission|setup|bootstrap|vault|error|warn/i.test(t)) {
    noticed.push(`${m.type()}: ${t.slice(0, 220)}`);
  }
});
page.on("requestfailed", (r) =>
  failed.push(`${r.method()} ${r.url().slice(0, 110)} :: ${r.failure()?.errorText}`),
);

// Track only API calls, and only while they are outstanding. The peak of this set
// is the concurrency the connection pool actually sees.
const inflight = new Map();
let peakInflight = 0;
let peakRoute = "";
const peakWitnesses = [];
const isApi = (u) => u.includes("/api/");
// WHICH SCREEN the peak happened on. Without it the measurement cannot tell a
// fan-out the setup gate is waiting on from one the dashboard legitimately makes,
// and a cut aimed at the wrong screen reads as "no effect".
let lastRoute = "/login";
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) lastRoute = new URL(f.url()).pathname;
});
page.on("request", (r) => {
  if (!isApi(r.url())) return;
  inflight.set(r.url(), Date.now());
  if (inflight.size > peakInflight) {
    peakInflight = inflight.size;
    peakWitnesses.length = 0;
    peakRoute = lastRoute;
    for (const u of inflight.keys()) peakWitnesses.push(u.replace(ORIGIN, "").slice(0, 90));
  }
});
const settle = (r) => inflight.delete(r.url());
page.on("response", settle);
page.on("requestfailed", settle);

let reached = false;
let hubRendered = false;
let visible = "";
try {
  await page.goto(`${ORIGIN}/login?redirect=%2Fone%2Fsetup`, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(() => !location.pathname.startsWith("/login"), undefined, { timeout: 90_000 })
    .catch(() => {});
  const navigate = (href) =>
    page.evaluate((h) => {
      window.dispatchEvent(
        new CustomEvent("app-internal-navigation-requested", {
          detail: { href: h, scroll: false },
        }),
      );
    }, href);

  // Two screens, because that is the walk a person actually makes. The hub is
  // where the admission guard decides; the cloud step is where the question
  // "where should your agent live" is finally asked. Asserting only the hub
  // would have called this reached while the door it leads to was still shut.
  await navigate("/one/setup");
  await page
    .locator('[data-voice-control-id="one_setup_tile_cloud"]')
    .waitFor({ state: "visible", timeout: BUDGET_MS });
  hubRendered = true;

  await navigate("/one/setup/cloud");

  // The claim under test, stated as something that can fail: the tier chooser
  // renders within the budget a person would actually wait.
  await page
    .locator('[data-testid="cloud-tier-choice"]')
    .waitFor({ state: "visible", timeout: BUDGET_MS });
  reached = true;
} catch (err) {
  noticed.push(`driver: ${String(err?.message || err).slice(0, 200)}`);
} finally {
  visible = await page
    .evaluate(() => document.body.innerText.slice(0, 200).replace(/\s+/g, " "))
    .catch(() => "(page gone)");
}

const stuck = [...inflight.entries()]
  .map(([u, t]) => [u.replace(ORIGIN, "").slice(0, 100), Math.round((Date.now() - t) / 1000)])
  .sort((a, b) => b[1] - a[1]);

console.log("=".repeat(72));
console.log(`FIRST-RUN REACHABILITY   ${reached ? "REACHED" : "NOT REACHED"}   uid=${UID}`);
console.log("=".repeat(72));
console.log(`  setup hub rendered within ${BUDGET_MS}ms         : ${hubRendered}`);
console.log(`  cloud-tier-choice visible within ${BUDGET_MS}ms : ${reached}`);
console.log(`  peak concurrent /api requests             : ${peakInflight}  (on ${peakRoute})`);
console.log(`  DB_POOL_MAX_SIZE it runs against          : ${DB_POOL_MAX_SIZE}`);
if (peakInflight > DB_POOL_MAX_SIZE) {
  console.log(`  OVER POOL by ${peakInflight - DB_POOL_MAX_SIZE}. Witnesses at the peak:`);
  for (const w of peakWitnesses.slice(0, 20)) console.log(`      ${w}`);
}
console.log(`  on screen: ${visible}`);
if (stuck.length) {
  console.log(`  still outstanding when we stopped (${stuck.length}):`);
  for (const [u, age] of stuck.slice(0, 15)) console.log(`      ${age}s  ${u}`);
}
if (failed.length) {
  console.log(`  failed requests (${failed.length}):`);
  for (const f of failed.slice(-10)) console.log(`      ${f}`);
}
if (noticed.length) {
  console.log(`  console (${noticed.length}, last 15):`);
  for (const l of noticed.slice(-15)) console.log(`      ${l}`);
}
console.log("=".repeat(72));

await ctx.close().catch(() => {});
await browser.close().catch(() => {});
process.exit(reached ? 0 : 1);
