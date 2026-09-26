#!/usr/bin/env node
// Reviewer rehearsal for the Trusted Devices surface.
//
// Proves the four founder-reported defects are fixed on a real reviewer session
// with an unlocked vault:
//   1. "Trusted devices" is a TOP-LEVEL profile row, not buried under Security.
//   2. The row opens the recursive Profile pane on the current route.
//   3. Status distinguishes trust, observed heartbeat, and revocation; it never
//      presents an old sync timestamp as current reachability.
//   4. Revisiting is cache-first: no blocking spinner over data already held.
// Plus vault continuity across every protected transition.
//
// READ-ONLY: it never unlinks a device, so it needs no shared-mutation
// authority. Nothing decrypted, no credentials, and no vault material is
// written to logs, screenshots, or tracked files.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(
  process.env.REVIEWER_APP_ORIGIN || "http://127.0.0.1:3000",
).replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);

const PROFILE_ROUTE = "/one?profile_pane=1";
const DEVICES_PANE_ROUTE =
  "/one?profile_pane=1&profile_panel=security&profile_detail=trusted-devices";

await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
});

const failures = [];
function check(label, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    failures.push(`${label}${detail ? ` -- ${detail}` : ""}`);
    process.stdout.write(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}\n`);
  }
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

let session;
try {
  // A cold authenticated entry must visibly hard-gate on the vault before any
  // passphrase is supplied.
  await reviewer.assertVisibleVaultChallenge(browser, PROFILE_ROUTE);
  process.stdout.write("  ok    cold entry hard-gates on the vault\n");

  session = await reviewer.openSession(browser, PROFILE_ROUTE, { allowQueryMutation: true });
  const { page } = session;
  await reviewer.assertVaultContinuity(page, PROFILE_ROUTE);

  // 1. Top-level placement. The row must be reachable from the profile root
  //    without first opening Security & privacy.
  const profileText = clean(await page.locator("body").innerText());
  check(
    "Trusted devices is a top-level profile row",
    profileText.includes("Trusted devices"),
    "not found on /one/profile",
  );

  // 2. Client navigation into the recursive pane keeps the vault unlocked and
  // leaves the underlying route at the entry surface.
  await reviewer.navigateInApp(page, DEVICES_PANE_ROUTE);
  await reviewer.assertVaultContinuity(page, DEVICES_PANE_ROUTE);
  check(
    "opens Trusted devices inside the Profile pane",
    page.url().includes("/one?") &&
      page.url().includes("profile_detail=trusted-devices") &&
      (await page.locator('[data-testid="profile-pane"]').count()) === 1,
    page.url(),
  );

  // This account route authenticates Firebase identity, not the PKM HCT.
  const identityToken = await session.capture.identityToken();
  const payload = await reviewer.fetchOwnerJson(
    "/api/account/trusted-devices",
    identityToken,
  );
  const devices = Array.isArray(payload?.devices) ? payload.devices : null;
  if (!devices) throw new Error("Trusted-devices API did not return a device list.");
  // Wait for the pane to render its result before interpreting an empty/loading
  // frame as an enrolled device without a status.
  await page.getByText(
    devices.length > 0
      ? /Trusted ·|Active now|Revoked ·|Sync status unavailable/
      : "No trusted devices are connected.",
  ).first().waitFor({ state: "visible" });
  const devicesText = clean(await page.locator("body").innerText());

  // 3. Honest status. "Active - last synced" claims live reachability that the
  //    server has no channel to observe; only trust state is known.
  check(
    "status label never claims live reachability",
    !/Active\s*[·.]\s*last synced/i.test(devicesText),
    "found a stale Active - last synced label",
  );
  const hasDevices = devices.length > 0;
  if (hasDevices) {
    check(
      "status label renders trust, heartbeat, or revocation state",
      /Trusted\s*[·.]|Active now|Revoked\s*[·.]|Sync status unavailable/i.test(devicesText),
      "no device status rendered",
    );
  } else {
    process.stdout.write(
      "  note  reviewer account has no enrolled devices; label assertion skipped\n",
    );
  }

  // 4. Pane context must retain both Profile chrome and the active detail.
  check(
    "pane context shows Profile and Trusted devices",
    /Profile/.test(devicesText) && /Trusted devices/.test(devicesText),
    "pane context missing",
  );

  // 5. Cache-first revisit: leaving and returning must paint from the warm
  //    cache rather than blocking on a spinner over data already held.
  await reviewer.navigateInApp(page, PROFILE_ROUTE);
  await reviewer.assertVaultContinuity(page, `${PROFILE_ROUTE} (return)`);
  await reviewer.navigateInApp(page, DEVICES_PANE_ROUTE);
  const warmText = clean(await page.locator("body").innerText());
  check(
    "warm revisit does not block on a loading spinner",
    !/Loading devices/i.test(warmText),
    "blocking loader rendered over cached data",
  );
  await reviewer.assertVaultContinuity(page, `${DEVICES_PANE_ROUTE} (warm)`);

  // 6. The API contract behind the surface, read through Firebase identity.
  check("trusted-devices API returns a device list", devices !== null);
  if (devices && devices.length > 0) {
    const device = devices[0];
    check(
      "device payload carries the sync-state fields",
      "status" in device && "last_synced_at" in device,
      `keys: ${Object.keys(device).join(",")}`,
    );
  }
  session.readOnlyGuard.assertNoBlockedMutation();
  session.capture.assertNoCriticalApiFailures("trusted devices");
} finally {
  await browser.close().catch(() => {});
}

if (failures.length > 0) {
  process.stdout.write(
    `\nreviewer trusted-devices rehearsal FAILED (${failures.length})\n`,
  );
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  "\nreviewer trusted-devices rehearsal PASS (read_only)\n",
);
