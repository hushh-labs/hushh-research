#!/usr/bin/env node

/**
 * End-to-end BYOC rehearsal: a person authorizes their OWN Google Cloud project,
 * hushh builds their private agent pod THERE, and the pod serves a turn on their
 * OWN Vertex ADC -- driven by the canonical reviewer identity instead of a human.
 *
 * WHY THIS EXISTS AS A SEPARATE SCRIPT
 * ------------------------------------
 * `verify-reviewer-byok-navigation.mjs` proves the BYOK/session contract holds.
 * It deliberately asserts nothing about a domain. This script is the domain
 * rehearsal the contract describes: it imports the same harness for identity,
 * unlock, memory-only capture and same-session navigation, and adds ONLY BYOC
 * assertions on top. It must never re-derive identity, unlock or navigation --
 * duplicating those is exactly what the BYOK contract forbids, and a second
 * copy of the unlock path is a second place for a passphrase to leak.
 *
 * WHY IT DEFAULTS TO READ-ONLY
 * ----------------------------
 * The journey's mutations are not undoable in the product:
 *
 *   * `/byoc/project/save` writes `user_cloud_project` onto the SHARED reviewer
 *     fixture's registry row. `set_user_cloud`'s own docstring says the
 *     authorization is deliberately never cleared, and no revocation route
 *     exists. After one live run the shared reviewer is permanently a BYOC
 *     person, and every later rehearsal that reaches provisioning targets that
 *     project rather than hushh's fleet.
 *   * `/managed/select` SCHEDULES the pod. It is the single irreversible act:
 *     the registry row enters `provisioning|connecting|provisioned`, and
 *     `ai_connection_gate` then answers "host already X" forever
 *     (ai_connection_gate.py:135-138). There is no product path back.
 *   * The substrate it builds in the customer project (KMS keyring + key, CMEK
 *     bucket, signing secret, Pub/Sub topic + subscription, scheduler job, pod
 *     service account, a PROJECT-LEVEL roles/aiplatform.user binding) is NOT
 *     removed by `deprovision`, which deletes the Cloud Run service and nothing
 *     else (user_gcp_backend.py:776-785). A KMS key cannot be deleted at all.
 *
 * So the default mode walks the whole journey and asserts everything reachable
 * WITHOUT writing, and the mutating half requires `--live` / `BYOC_LIVE=1`.
 *
 * WHY EVERY ASSERTION IS SERVER-SIDE
 * ----------------------------------
 * A toast is not evidence. Worse, the setup hub caches `bootstrap-state` for the
 * session (pre-vault-user-state-service.ts:296-306) and nothing invalidates it
 * after the cloud step, so the tile can still read "Required" while the server
 * has recorded the cloud. Asserting the UI there produces a false negative, and
 * asserting it the other way would produce a false PASS. Every state claim in
 * this script is read back from the authoritative endpoint.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

const appOrigin = String(
  process.env.REVIEWER_APP_ORIGIN || "https://dev.one.hushh.ai"
).replace(/\/$/, "");
// Default is the pre-authorized dev target. It is NOT what the product prefills:
// `suggest_project_id` derives a name deterministically from the Firebase UID, so
// the card offers something else entirely and the field is `editable: true`. This
// rehearsal types the authorized id on purpose; accepting the prefill would record
// a project that does not exist and hold no grant.
const byocProjectId = String(process.env.BYOC_PROJECT_ID || "hussh-one-byoc-01").trim();
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
// `_HANDSHAKE_OVERDUE_SECONDS` is 600: the pod generates its X25519 keypair inside
// its own runtime and pushes the public half, and the status poll is what collects
// it. Under ten minutes in `connecting` is normal, so the budget has to exceed it.
const podWaitMs = Number(process.env.BYOC_POD_WAIT_MS || 900_000);
// An economy pod scales to zero and a cold start is ~150s, during which the relay
// answers 503. That is a cold pod, not a broken one.
const turnWaitMs = Number(process.env.BYOC_TURN_WAIT_MS || 300_000);
const turnMessage = String(
  process.env.BYOC_TURN_MESSAGE || "Say hello in one short sentence."
);
const live = process.argv.includes("--live") || process.env.BYOC_LIVE === "1";
// Opt-in, dry-only: clicking "I need to create this project" POSTs /plan (which
// writes nothing) but sets `expanded`, which REMOVES `byoc-project-existing` and
// replaces it with `byoc-project-done`. They are mutually exclusive branches, not
// alternatives on one screen, so a live run picks one branch and stays in it.
const exercisePlanBranch = process.env.BYOC_EXERCISE_PLAN === "1";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    [
      "End-to-end BYOC journey rehearsal for the canonical reviewer identity.",
      "",
      "MODES",
      "  DRY (default)   Read-only. Walks reachability, the setup hub, the cloud",
      "                  screen render and every server-side precondition, and",
      "                  stops before the first write.",
      "  LIVE (--live)   Adds the mutating half: saves the cloud, selects the",
      "                  managed runtime (this SCHEDULES the pod and cannot be",
      "                  undone in the product), waits for the pod, runs one turn.",
      "                  Also enabled by BYOC_LIVE=1.",
      "",
      "LIVE MUTATES A SHARED FIXTURE AND A REAL CLOUD PROJECT",
      "  * POST /api/one/runtime/byoc/project/save   registry row + server 'cloud' marker",
      "  * POST /api/one/runtime/managed/select      SCHEDULES the pod (irreversible)",
      "  * POST /api/vault/pre-vault-state           'connections' preference marker",
      "  * POST /api/one/u/<hushhId>/turn            billable inference on the customer project",
      "  Teardown is manual: deprovision deletes only the Cloud Run service.",
      "",
      "ENVIRONMENT",
      "  REVIEWER_APP_ORIGIN      default https://dev.one.hushh.ai",
      "  BYOC_PROJECT_ID          default hussh-one-byoc-01 (must already be authorized)",
      "  REVIEWER_APP_TIMEOUT_MS  default 360000 (per-session budget)",
      "  BYOC_POD_WAIT_MS         default 900000 (handshake window is 600s)",
      "  BYOC_TURN_WAIT_MS        default 300000 (cold economy pod is ~150s)",
      "  BYOC_TURN_MESSAGE        default a one-sentence greeting",
      "  BYOC_LIVE=1              same as --live",
      "  BYOC_EXERCISE_PLAN=1     dry-only: also render the /plan branch of the card",
      "  PLAYWRIGHT_HEADLESS=0    run headed",
      "  REVIEWER_UID             identity override; resolveReviewerTestIdentity reads",
      "                           process.env before any file, so a dev-targeted run",
      "                           can point at the dev reviewer without editing",
      "                           consent-protocol/.env.local (whose passphrase is",
      "                           correct for dev and must not be repointed blindly).",
      "",
      "FAILURE CLASSES (first broken boundary, fail closed)",
      "  reviewer-identity-or-environment-parity   authentication-or-passphrase-wrapper",
      "  vault-key-hash-integrity                  same-session-navigation-continuity",
      "  domain-storage-scope-projection           registry-row-missing",
      "  cloud-not-authorized                      ai-connection-not-ready",
      "  journey-already-consumed                  substrate-failed",
      "  pod-image-pull                            pod-not-ready",
      "  turn-failed",
      "",
    ].join("\n")
  );
  process.exit(0);
}

/**
 * The contract's taxonomy (1-6), extended with the BYOC boundaries. The point of
 * the class is triage: it names WHICH layer broke, so nobody re-derives it from a
 * stack trace at 3am.
 */
const CLASS = {
  IDENTITY: "reviewer-identity-or-environment-parity",
  AUTH: "authentication-or-passphrase-wrapper",
  KEY_INTEGRITY: "vault-key-hash-integrity",
  NAVIGATION: "same-session-navigation-continuity",
  DOMAIN: "domain-storage-scope-projection",
  // BYOC-specific, in journey order.
  REGISTRY_ROW_MISSING: "registry-row-missing",
  CLOUD_NOT_AUTHORIZED: "cloud-not-authorized",
  AI_CONNECTION_NOT_READY: "ai-connection-not-ready",
  JOURNEY_ALREADY_CONSUMED: "journey-already-consumed",
  SUBSTRATE_FAILED: "substrate-failed",
  POD_IMAGE_PULL: "pod-image-pull",
  POD_NOT_READY: "pod-not-ready",
  TURN_FAILED: "turn-failed",
};

class JourneyError extends Error {
  constructor(failureClass, step, message) {
    super(message);
    this.failureClass = failureClass;
    this.step = step;
  }
}

let currentStep = "startup";

function fail(failureClass, message) {
  throw new JourneyError(failureClass, currentStep, message);
}

function log(line) {
  process.stdout.write(`[byoc-journey] ${line}\n`);
}

async function step(name, run) {
  currentStep = name;
  log(`step ${name}`);
  const result = await run();
  return result;
}

/**
 * Observe the Firebase bearer the app already sends, and never mint one.
 *
 * THIS IS NOT A SECOND IDENTITY PATH. The harness's `attachMemoryOnlyCapture`
 * captures the VAULT_OWNER token off `/api/pkm/` requests, and `fetchOwnerJson`
 * replays it -- the same shape as this. But the owner token is the wrong
 * credential for every endpoint this journey asserts on: `/personal-agent/status`,
 * all four `/byoc/project/*` routes and `/managed/select` are
 * `Depends(require_firebase_auth)`, which validates a Firebase ID token only and
 * answers 401 to anything else (confirmed against dev this session). So the
 * authoritative reads need the bearer the app itself is already attaching.
 *
 * The path allowlist is deliberate rather than a heuristic on the token's shape:
 * only routes known to carry the Firebase bearer are read, so the vault-owner
 * token can never be picked up here by accident.
 *
 * The value stays in process memory, is never printed, and is never written
 * anywhere. Only its presence is ever reported.
 */
const FIREBASE_BEARER_PATHS = [
  "/api/vault/bootstrap-state",
  "/api/vault/pre-vault-state",
  "/api/one/runtime/",
  "/api/one/personal-agent/status",
  "/api/one/u/",
];

function attachFirebaseBearerCapture(page, endpointPath) {
  let bearer = "";
  let observed = 0;
  page.on("request", (request) => {
    const pathname = endpointPath(request.url());
    if (!FIREBASE_BEARER_PATHS.some((prefix) => pathname.startsWith(prefix))) return;
    const authorization = request.headers().authorization || "";
    if (!authorization.startsWith("Bearer ")) return;
    const token = authorization.slice(7);
    if (!token || token === bearer) return;
    bearer = token;
    observed += 1;
  });
  return {
    current: () => bearer,
    observedCount: () => observed,
    async waitForFirst(waitMs) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (bearer) return bearer;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      fail(
        CLASS.AUTH,
        "The app never sent an authenticated request on a Firebase-bearer route, so no authoritative read is possible."
      );
      return "";
    },
    async waitForRotation(previous, waitMs) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (bearer && bearer !== previous) return bearer;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return "";
    },
  };
}

/**
 * Capture ONE response body off the page's own network.
 *
 * Used for the two mutating calls. The alternative -- re-issuing `/save` or
 * `/managed/select` from Node to inspect the answer -- would run the mutation a
 * second time. `/save` is idempotent-ish; `/managed/select` emphatically is not.
 * So the click stays the only caller and this reads what it got back.
 */
function captureJsonResponse(page, endpointPath, pathname, waitMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.off("response", onResponse);
      resolve(null);
    }, waitMs);
    const onResponse = (response) => {
      if (endpointPath(response.url()) !== pathname) return;
      const status = response.status();
      response
        .json()
        .catch(() => null)
        .then((payload) => {
          clearTimeout(timer);
          page.off("response", onResponse);
          resolve({ status, payload });
        });
    };
    page.on("response", onResponse);
  });
}

function summarizeStatus(payload) {
  // Identifiers and status only. `hushhId` is an identifier a teardown needs and
  // the app renders it to the person; the pod's public key material is never read.
  const parts = [`state=${payload?.state || "unknown"}`];
  if (payload?.hushhId) parts.push(`hushhId=${payload.hushhId}`);
  if (payload?.health) parts.push(`health=${payload.health}`);
  parts.push(`featureEnabled=${payload?.featureEnabled === true}`);
  return parts.join(" ");
}

const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
});

let session = null;
let exitCode = 0;

log(
  `mode=${live ? "LIVE (mutating)" : "DRY (read-only)"} origin=${appOrigin} project=${byocProjectId} reviewer_uid_prefix=${reviewer.reviewerUid.slice(0, 8)}…`
);
if (live) {
  log(
    "LIVE: this run writes to the shared reviewer fixture and builds real resources in the customer project. Teardown is manual."
  );
} else {
  log("DRY: no request that writes state will be issued. Pass --live to run the mutating half.");
}

try {
  // ---------------------------------------------------------------------------
  // PHASE 0 -- environment parity, before a browser is worth opening.
  // ---------------------------------------------------------------------------
  await step("review-mode-reachable", async () => {
    const response = await fetch(`${appOrigin}/api/app-config/review-mode`, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.enabled !== true) {
      fail(
        CLASS.IDENTITY,
        `${appOrigin} does not have reviewer mode enabled (HTTP ${response.status}). The reviewer bridge cannot mint a session there.`
      );
    }
    log(`review_mode enabled=true origin=${appOrigin}`);
  });

  // ---------------------------------------------------------------------------
  // PHASE A -- session. The harness owns this entirely.
  // ---------------------------------------------------------------------------
  session = await step("open-session", async () => {
    try {
      // The ONLY page.goto in this run, and it happens inside the harness. Every
      // later transition is an in-app navigation or a real click, because each one
      // claims same-session vault-key continuity.
      return await reviewer.openSession(browser, "/one/setup");
    } catch (error) {
      // `uid_mismatch` is the known dev trap: the bridge signs in successfully and
      // then rejects its own session because the configured REVIEWER_UID is not the
      // UID the hub mints for. It is an identity/parity fault, not an auth fault.
      const message = String(error?.cause?.message || error?.message || error);
      const failureClass = /uid_mismatch/.test(message) ? CLASS.IDENTITY : CLASS.AUTH;
      fail(
        failureClass,
        `${message} -- if this is uid_mismatch, export REVIEWER_UID for this origin (process.env wins over every env file) rather than editing consent-protocol/.env.local.`
      );
      return null;
    }
  });

  const { page, capture } = session;
  const bearerCapture = attachFirebaseBearerCapture(page, reviewer.endpointPath);

  await step("vault-key-commitment", async () => {
    // Only the commitment. Node must never derive, decrypt or compare a vault key;
    // the browser is the only place that opens the wrapper.
    const commitment = reviewer.vaultKeyCommitment(await capture.vaultState());
    if (!commitment) fail(CLASS.KEY_INTEGRITY, "Reviewer vault state carried no key commitment.");
    log(`vault_key_commitment present=true length=${commitment.length}`);
  });

  await step("land-on-setup-hub", async () => {
    // `openSession` deliberately does not assert the destination -- the redirect is
    // state-aware and may legitimately land on onboarding. So converge on the hub
    // through the app's own navigation event, never a reload.
    const here = await page.evaluate(() => window.location.pathname);
    if (here !== "/one/setup") {
      try {
        await reviewer.navigateInApp(page, "/one/setup");
      } catch (error) {
        fail(CLASS.NAVIGATION, `Could not reach /one/setup in-app: ${String(error?.message || error)}`);
      }
    }
    await assertRoute("/one/setup", "native-route-one-setup");
  });

  /**
   * Route identity comes from the app's own beacon, not from a DOM testid.
   * `AppPageShell`'s `nativeTest` marker is published on
   * `window.__HUSHH_NATIVE_TEST__.beacon` (lib/testing/native-test.ts:326-333) and
   * is never rendered as an attribute -- a selector like
   * `[data-testid="native-route-one-setup-cloud"]` would wait forever on a working
   * app.
   */
  async function assertRoute(routeId, marker) {
    try {
      await page.waitForFunction(
        ({ expectedRouteId, expectedMarker }) => {
          const beacon = window.__HUSHH_NATIVE_TEST__?.beacon;
          return beacon?.routeId === expectedRouteId && beacon?.marker === expectedMarker;
        },
        { expectedRouteId: routeId, expectedMarker: marker },
        { timeout: Math.min(timeoutMs, 60_000) }
      );
    } catch {
      const beacon = await page.evaluate(() => ({
        routeId: window.__HUSHH_NATIVE_TEST__?.beacon?.routeId || "none",
        path: window.location.pathname,
      }));
      fail(
        CLASS.NAVIGATION,
        `Expected route ${routeId} (marker ${marker}) but the app reports routeId=${beacon.routeId} path=${beacon.path}.`
      );
    }
    await reviewer.assertVaultContinuity(page, routeId);
  }

  /**
   * Force the app to re-issue an authenticated read so a rotated Firebase bearer is
   * observed. A Firebase ID token lives an hour and this run can outlast one during
   * the pod wait; bouncing between two protected setup routes is read-only, uses the
   * app's own navigation, and keeps the same session key.
   */
  async function reprimeBearer() {
    const previous = bearerCapture.current();
    const here = await page.evaluate(() => window.location.pathname);
    const other = here === "/one/setup" ? "/one/setup/connections" : "/one/setup";
    await reviewer.navigateInApp(page, other);
    await reviewer.navigateInApp(page, here);
    return bearerCapture.waitForRotation(previous, 30_000);
  }

  /**
   * The authoritative read. Returns status + payload and classifies nothing: the
   * caller knows which boundary a bad answer belongs to.
   */
  async function authoritative(pathname, { method = "GET", body = null } = {}) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const token = bearerCapture.current() || (await bearerCapture.waitForFirst(60_000));
      const response = await fetch(`${appOrigin}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Cache-Control": "no-cache",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await response.text();
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        fail(CLASS.DOMAIN, `${pathname} returned non-JSON HTTP ${response.status}.`);
      }
      if (response.status === 401 && attempt === 1) {
        // Almost always an expired capture rather than a real authorization fault.
        await reprimeBearer();
        continue;
      }
      return { status: response.status, payload };
    }
    return { status: 401, payload: null };
  }

  // Server truth, never the hub's session cache. `bootstrapState` returns a cached
  // value unless forced (pre-vault-user-state-service.ts:296-306) and nothing
  // invalidates it after the cloud step, so a UI-derived read here would lie.
  async function readBootstrapState() {
    const { status, payload } = await authoritative("/api/vault/bootstrap-state", {
      method: "POST",
      body: {},
    });
    if (status !== 200 || !payload) {
      fail(CLASS.DOMAIN, `/api/vault/bootstrap-state answered HTTP ${status}.`);
    }
    return payload;
  }

  async function readAgentStatus() {
    const { status, payload } = await authoritative("/api/one/personal-agent/status");
    if (status !== 200 || !payload) {
      fail(CLASS.DOMAIN, `/api/one/personal-agent/status answered HTTP ${status}.`);
    }
    return payload;
  }

  // ---------------------------------------------------------------------------
  // PHASE B -- server-side preconditions. All read-only, in both modes.
  // ---------------------------------------------------------------------------
  await step("preconditions", async () => {
    await bearerCapture.waitForFirst(60_000);
    const state = await readBootstrapState();

    // The gate that decides whether the whole journey is even possible.
    // `_reserve_pending_agent_record` returns False unless `phone_verified is True`,
    // and without a row `/byoc/project/save` 409s permanently while telling the
    // person to verify a phone they may already have verified.
    if (state.phoneVerified !== true) {
      fail(
        CLASS.REGISTRY_ROW_MISSING,
        "The reviewer's phone is not verified, so the pending registry row can never be reserved and /byoc/project/save will 409 forever. Signing in does not create this: only a real OTP through /api/account/phone/claim, or a phone already on the Firebase user record, sets it."
      );
    }

    const capabilities = Array.isArray(state.setupCapabilityIds) ? state.setupCapabilityIds : [];
    const status = await readAgentStatus();
    if (status.featureEnabled !== true) {
      fail(
        CLASS.DOMAIN,
        "personal_agent_enabled() is off on this deployment, so register_pending and the provisioning gate cannot run."
      );
    }

    // Refuse to mutate a fixture whose journey is already spent. Once the row is in
    // provisioning|connecting|provisioned the gate answers "host already X" for
    // every later selection and the BYOC path cannot be re-triggered from the
    // product for this identity.
    if (live && status.state !== "reserved") {
      fail(
        CLASS.JOURNEY_ALREADY_CONSUMED,
        `The reviewer's agent is already in state=${status.state}. A live run cannot re-trigger the BYOC journey for an identity that already has a host; ai_connection_gate refuses with "host already ...". Use a fresh identity or reconcile the registry row deliberately.`
      );
    }

    log(
      `precondition phone_verified=true ${summarizeStatus(status)} capabilities=${capabilities.length} cloud_marker=${capabilities.includes("cloud")} runtime_choice=${state.oneRuntimeSetupChoice || "none"}`
    );
    return { capabilities, status };
  });

  // ---------------------------------------------------------------------------
  // PHASE C -- the cloud screen. Render + suggestion + name check, still no write.
  // ---------------------------------------------------------------------------
  await step("open-cloud-step", async () => {
    // The hub tile carries no distinctive testid -- `SettingsRow` defaults every row
    // to `settings-row` -- so it is addressed by its voice control id. The tile calls
    // `requestInternalAppNavigation`, and `navigateInApp` dispatches the same event,
    // which is the contract-compliant equivalent of the click.
    const tile = page.locator('[data-voice-control-id="one_setup_tile_cloud"]');
    if (!(await tile.isVisible().catch(() => false))) {
      fail(
        CLASS.DOMAIN,
        'The setup hub did not render the "Your cloud" tile ([data-voice-control-id="one_setup_tile_cloud"]).'
      );
    }
    try {
      await reviewer.navigateInApp(page, "/one/setup/cloud");
    } catch (error) {
      fail(CLASS.NAVIGATION, `Could not reach /one/setup/cloud in-app: ${String(error?.message || error)}`);
    }
    await assertRoute("/one/setup/cloud", "native-route-one-setup-cloud");
  });

  await step("cloud-card-render", async () => {
    const input = page.locator('[data-testid="byoc-project-id-input"]');
    try {
      await input.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 60_000) });
    } catch {
      fail(CLASS.DOMAIN, "The BYOC cloud card never rendered its project-id input.");
    }

    // The suggestion is deterministic per uid (`suggest_project_id`), so a prefill
    // that changes under a person naming their own infrastructure would be a defect.
    // Read the route directly rather than trusting the field, then compare.
    const suggest = await authoritative("/api/one/runtime/byoc/project/suggest");
    if (suggest.status !== 200) {
      fail(CLASS.DOMAIN, `/byoc/project/suggest answered HTTP ${suggest.status}.`);
    }
    const prefilled = String(await input.inputValue());
    if (!prefilled) fail(CLASS.DOMAIN, "The project-id field rendered empty; the suggestion never reached the card.");
    if (suggest.payload?.editable !== true) {
      fail(
        CLASS.DOMAIN,
        "The suggested project id is not editable, so a person cannot name a project they already authorized."
      );
    }
    if (prefilled !== suggest.payload?.projectId) {
      fail(
        CLASS.DOMAIN,
        `The card prefilled ${prefilled} but /suggest answers ${suggest.payload?.projectId}; the suggestion is not stable between the two reads.`
      );
    }
    log(
      `cloud_card prefill=${prefilled} editable=true target=${byocProjectId} prefill_is_target=${prefilled === byocProjectId}`
    );
  });

  await step("name-the-authorized-project", async () => {
    const input = page.locator('[data-testid="byoc-project-id-input"]');
    // The card debounces 400ms before POSTing /check, which writes nothing. Wait for
    // the real response rather than sleeping.
    const checkResponse = captureJsonResponse(
      page,
      reviewer.endpointPath,
      "/api/one/runtime/byoc/project/check",
      Math.min(timeoutMs, 30_000)
    );
    await input.fill(byocProjectId);
    const check = await checkResponse;
    if (!check) fail(CLASS.DOMAIN, "Typing the project id never produced a /byoc/project/check call.");
    if (check.status !== 200) fail(CLASS.DOMAIN, `/byoc/project/check answered HTTP ${check.status}.`);
    if (check.payload?.valid !== true) {
      fail(CLASS.DOMAIN, `Google would reject the project id ${byocProjectId}: ${check.payload?.reason || "no reason given"}.`);
    }
    // EXPECTED, NOT A BUG: `available` is null for every id. The route calls
    // `check_project_id` with no token (runtime.py:397), so cloudresourcemanager
    // answers 401 and the tri-state falls into "could not determine". It fails open
    // on purpose -- rendering null as taken would tell a person a free name is used.
    // Asserting `available === true` or the "That name is free." copy would fail
    // against a working system, so this asserts only that it is not a hard NO.
    if (check.payload?.available === false) {
      fail(CLASS.DOMAIN, `The availability probe reports ${byocProjectId} is taken by another account.`);
    }
    log(`project_check valid=true available=${String(check.payload?.available)} (null here is expected: the probe is unauthenticated)`);

    // Both continue buttons call the same handler; `canContinue` gates both on
    // valid && available !== false && length > 0.
    const existing = page.locator('[data-testid="byoc-project-existing"]');
    if (!(await existing.isEnabled().catch(() => false))) {
      fail(
        CLASS.DOMAIN,
        "The continue control stayed disabled for a valid name, so the tri-state availability did not fail open."
      );
    }
  });

  if (exercisePlanBranch && !live) {
    await step("plan-branch-render", async () => {
      const planResponse = captureJsonResponse(
        page,
        reviewer.endpointPath,
        "/api/one/runtime/byoc/project/plan",
        Math.min(timeoutMs, 30_000)
      );
      await page.locator('[data-testid="byoc-project-continue"]').click();
      const plan = await planResponse;
      if (!plan || plan.status !== 200) {
        fail(CLASS.DOMAIN, `/byoc/project/plan answered HTTP ${plan?.status ?? "nothing"}.`);
      }
      // The delegated disclosure is structurally unreachable from this card: the
      // client always sends parentType:null and parentId:"", and the route only
      // builds `delegated.grant` when both are present. So assert the guided route
      // and the unavailable copy; asserting the <details> element would fail forever.
      if (!plan.payload?.guided?.consoleUrl || !plan.payload?.guided?.cliCommand) {
        fail(CLASS.DOMAIN, "The guided creation route came back without a console link or CLI command.");
      }
      await page.locator('[data-testid="byoc-console-link"]').waitFor({ state: "visible" });
      log(
        `plan_branch guided=true delegated_grant=${Boolean(plan.payload?.delegated?.grant)} (absent is expected: the card sends no parent)`
      );
    });
  }

  if (!live) {
    capture.assertNoCriticalApiFailures("byoc dry walk");
    log(
      "DRY PASS reachable=1 session=1 preconditions=1 cloud_card=1 name_checked=1 mutations=0"
    );
    log(
      `next: --live would POST /byoc/project/save for ${byocProjectId}, then /managed/select (schedules the pod), then one turn.`
    );
  } else {
    // -------------------------------------------------------------------------
    // PHASE D -- LIVE. First mutation.
    // -------------------------------------------------------------------------
    await step("save-cloud", async () => {
      const saveResponse = captureJsonResponse(
        page,
        reviewer.endpointPath,
        "/api/one/runtime/byoc/project/save",
        Math.min(timeoutMs, 120_000)
      );
      // Unexpanded branch on purpose: clicking "I need to create this project"
      // would set `expanded`, remove this control and surface `byoc-project-done`
      // instead. One branch per run.
      await page.locator('[data-testid="byoc-project-existing"]').click();
      const save = await saveResponse;
      if (!save) fail(CLASS.DOMAIN, "The save click never produced a /byoc/project/save call.");

      if (save.status === 409) {
        // With a verified phone this IS a bug: `_reserve_pending_agent_record`
        // reserves the pending row and retries. A 409 here means that repair
        // regressed, or the phone flag flipped between the precondition and now.
        fail(
          CLASS.REGISTRY_ROW_MISSING,
          "/byoc/project/save returned 409 NO_AGENT_RECORD for a phone-verified reviewer. The pending-row reservation did not run."
        );
      }
      if (save.status !== 200) fail(CLASS.DOMAIN, `/byoc/project/save answered HTTP ${save.status}.`);

      const payload = save.payload || {};
      if (payload.projectId !== byocProjectId) {
        fail(CLASS.DOMAIN, `Saved project is ${payload.projectId}, not the authorized ${byocProjectId}.`);
      }
      // `hushhCaller` is the identity a person authorizes. Empty means
      // HUSSH_CONSENT_PLANE_SA is unset on the hub and the script it prints would be
      // unrunnable; a `serviceAccount:`-prefixed value means `_bare_service_account`
      // regressed and the script would build `serviceAccount:serviceAccount:...`.
      const hushhCaller = String(payload.hushhCaller || "");
      if (!hushhCaller) fail(CLASS.DOMAIN, "/byoc/project/save returned an empty hushhCaller; the hub cannot name the identity to authorize.");
      if (hushhCaller.startsWith("serviceAccount:")) {
        fail(CLASS.DOMAIN, `hushhCaller carries a policy-member prefix (${hushhCaller}); the authorization script would build an invalid member.`);
      }
      if (payload.authorized !== true) {
        // A first-time NO is the documented order for a person: they need
        // hushhCaller in order to run the script. For a project this session
        // already authorized it is contrary evidence that the grant regressed.
        fail(
          CLASS.CLOUD_NOT_AUTHORIZED,
          `${byocProjectId} answered authorized=false. mint_bootstrap_token could not impersonate ${payload.bootstrapServiceAccount}. Check that roles/iam.serviceAccountTokenCreator on that account is still held by ${hushhCaller}.`
        );
      }
      log(
        `cloud_saved project=${payload.projectId} region=${payload.region} bootstrap_sa=${payload.bootstrapServiceAccount} authorized=true caller=${hushhCaller}`
      );
      return payload;
    });

    await step("cloud-marker-server-side", async () => {
      // THE DURABLE PROOF. The "cloud" marker is written server-side only on the
      // authorized branch (runtime.py:632-648) and there is deliberately no client
      // writer, so this is the one assertion that cannot be satisfied by the UI
      // having felt successful. Read it fresh -- the hub's session cache is stale by
      // construction at this point.
      const state = await readBootstrapState();
      const capabilities = Array.isArray(state.setupCapabilityIds) ? state.setupCapabilityIds : [];
      if (!capabilities.includes("cloud")) {
        fail(
          CLASS.CLOUD_NOT_AUTHORIZED,
          'The server recorded no "cloud" capability after an authorized save, so the ordering gate will refuse provisioning with "your cloud is named but not yet authorized".'
        );
      }
      const errorVisible = await page
        .locator('[data-testid="byoc-cloud-error"]')
        .isVisible()
        .catch(() => false);
      if (errorVisible) fail(CLASS.DOMAIN, "The cloud screen rendered its error state after a 200 save.");
      log(`cloud_marker server_side=true capabilities=${capabilities.length}`);
    });

    await step("finish-cloud-step", async () => {
      const footer = page.locator('[data-voice-control-id="one-setup-cloud-terminal"]');
      if (!(await footer.isEnabled().catch(() => false))) {
        fail(CLASS.DOMAIN, "The cloud footer stayed disabled after a proven authorization.");
      }
      // A real click on the user-visible control. It calls
      // `requestInternalAppNavigation`, so the session and its key survive.
      await footer.click();
      await page.waitForFunction(() => window.location.pathname === "/one/setup", undefined, {
        timeout: Math.min(timeoutMs, 60_000),
      });
      await assertRoute("/one/setup", "native-route-one-setup");
      // NOT asserted: that the hub tile now reads done. It reads from the session
      // cache nothing invalidates, so it can still say "Required" while the server
      // has the marker. The gate itself force-refreshes; the display does not.
      log("cloud_step finished; hub tile state deliberately not asserted (stale session cache is expected here)");
    });

    // -------------------------------------------------------------------------
    // PHASE E -- AI access. This is what actually provisions.
    // -------------------------------------------------------------------------
    await step("open-ai-access", async () => {
      const tile = page.locator('[data-voice-control-id="one_setup_tile_connections"]');
      if (!(await tile.isVisible().catch(() => false))) {
        fail(CLASS.DOMAIN, 'The setup hub did not render the "AI access" tile.');
      }
      try {
        await reviewer.navigateInApp(page, "/one/setup/connections");
      } catch (error) {
        fail(CLASS.NAVIGATION, `Could not reach /one/setup/connections in-app: ${String(error?.message || error)}`);
      }
      await assertRoute("/one/setup/connections", "native-route-one-setup-connections");
      await page
        .locator('[data-testid="profile-gemini-runtime"]')
        .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 60_000) });
    });

    await step("select-managed-runtime", async () => {
      // ORDER IS LOAD-BEARING AND THE PRODUCT DOES NOT ENFORCE IT. The hub renders
      // this tile with the label "After your cloud" but never disables it or gates
      // its href. If /managed/select runs before /byoc/project/save,
      // `resolve_user_cloud` returns None, the BYOC refusal never fires, and a
      // MANAGED pod is scheduled on hushh's fleet -- after which this identity can
      // never take the BYOC path again. So the order is enforced here, in the
      // script, against the server's own record rather than against a click order.
      const state = await readBootstrapState();
      const capabilities = Array.isArray(state.setupCapabilityIds) ? state.setupCapabilityIds : [];
      if (!capabilities.includes("cloud")) {
        fail(
          CLASS.CLOUD_NOT_AUTHORIZED,
          "Refusing to select a runtime before the server records the cloud. Selecting now would schedule a pod on hushh's fleet and permanently strand this identity."
        );
      }
      const before = await readAgentStatus();
      if (before.state !== "reserved") {
        fail(
          CLASS.JOURNEY_ALREADY_CONSUMED,
          `The registry row moved to state=${before.state} before the selection; something else already claimed a host for this identity.`
        );
      }

      const selectResponse = captureJsonResponse(
        page,
        reviewer.endpointPath,
        "/api/one/runtime/managed/select",
        Math.min(timeoutMs, 120_000)
      );
      await page.locator('[data-testid="profile-managed-runtime"] button[aria-pressed]').click();
      const select = await selectResponse;
      if (!select) fail(CLASS.DOMAIN, "Choosing managed never produced a /managed/select call.");

      if (select.status === 503) {
        // The readiness probe targets the hub's own GOOGLE_CLOUD_PROJECT and a
        // failed probe means NO pod was created -- honest ordering, not a silent
        // half-provision.
        fail(
          CLASS.AI_CONNECTION_NOT_READY,
          "MANAGED_GEMINI_NOT_READY: the hub's own Vertex probe failed, so nothing was provisioned. The pod is not affected; the hub's model access is."
        );
      }
      if (select.status !== 200) fail(CLASS.DOMAIN, `/managed/select answered HTTP ${select.status}.`);

      const payload = select.payload || {};
      const reason = String(payload.agentReason || "");
      if (payload.agentScheduled !== true) {
        if (/not yet authorized/i.test(reason)) {
          fail(
            CLASS.CLOUD_NOT_AUTHORIZED,
            `The gate refused with "${reason}" even though the server recorded the cloud marker, so user_cloud_authorized_at did not land.`
          );
        }
        if (/host already/i.test(reason)) {
          fail(CLASS.JOURNEY_ALREADY_CONSUMED, `The gate refused with "${reason}".`);
        }
        if (/verified phone/i.test(reason)) {
          fail(CLASS.REGISTRY_ROW_MISSING, `The gate refused with "${reason}".`);
        }
        fail(CLASS.DOMAIN, `The gate scheduled nothing: "${reason || "no reason given"}".`);
      }
      // The only string reachable from the success branch (ai_connection_gate.py:174).
      if (reason !== "ai connection verified") {
        fail(CLASS.DOMAIN, `agentScheduled is true but the reason is "${reason}", which the success branch cannot produce.`);
      }
      log(`provisioning_scheduled=true reason="${reason}" model=${payload.model || "unknown"} location=${payload.location || "unknown"}`);
      return payload;
    });

    await step("runtime-choice-marker", async () => {
      // The asymmetry is worth keeping visible: "connections" is a client-asserted
      // preference, while "cloud" was a server-proven fact. Do not read them as
      // equally strong evidence.
      const state = await readBootstrapState();
      const capabilities = Array.isArray(state.setupCapabilityIds) ? state.setupCapabilityIds : [];
      log(
        `runtime_choice=${state.oneRuntimeSetupChoice || "none"} connections_marker=${capabilities.includes("connections")} (client-asserted) cloud_marker=${capabilities.includes("cloud")} (server-proven)`
      );
    });

    // -------------------------------------------------------------------------
    // PHASE F -- the pod, in the customer's project.
    // -------------------------------------------------------------------------
    const podStatus = await step("wait-for-pod", async () => {
      const deadline = Date.now() + podWaitMs;
      let last = "";
      let leftReserved = false;
      let connectingSince = 0;
      while (Date.now() < deadline) {
        const status = await readAgentStatus();
        const state = String(status.state || "");
        if (state !== last) {
          log(`pod ${summarizeStatus(status)}`);
          last = state;
        }
        if (state !== "reserved") leftReserved = true;
        if (state === "connecting" && !connectingSince) connectingSince = Date.now();
        if (state === "failed") {
          // The substrate step raises before any receipt is persisted, so a failure
          // here can have left real resources in the customer project that no row
          // names. Say so at the moment it is still cheap to go look.
          fail(
            CLASS.SUBSTRATE_FAILED,
            `Provisioning failed for ${status.hushhId || "an unrecorded HusshID"}. Inventory ${byocProjectId} for one-pod-* / one-mail-* resources now: a run that fails at the Cloud Run step writes no substrate receipt, so nothing in the database will name them later.`
          );
        }
        if (state === "active") return status;
        // Past the handshake window the pod is up but never pushed its public key.
        // On this lane that has meant a crash-looping revision: an APP_SIGNING_KEY
        // secretKeyRef naming a secret the bootstrap never created, a
        // GOOGLE_CLOUD_LOCATION Vertex does not serve, or internal ingress making a
        // cross-project pod unreachable. All three were fixed in fde9ff733; a pod
        // rendered before that deploy still carries them and cannot be repaired by
        // redeploying the hub.
        if (connectingSince && Date.now() - connectingSince > 600_000) {
          fail(
            CLASS.POD_NOT_READY,
            `The pod for ${status.hushhId} has been connecting for over ten minutes, so its startup key push never landed. Check the revision in ${byocProjectId}: probe=http /health, the APP_SIGNING_KEY secretKeyRef name, GOOGLE_CLOUD_LOCATION, and the ingress annotation. Ready=True is not proof it serves.`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      const failureClass = leftReserved ? CLASS.POD_NOT_READY : CLASS.SUBSTRATE_FAILED;
      fail(
        failureClass,
        leftReserved
          ? `The pod never reached active within ${Math.round(podWaitMs / 1000)}s (last state=${last}).`
          : `The registry row never left reserved within ${Math.round(podWaitMs / 1000)}s, so nothing was built at all.`
      );
      return null;
    });

    if (!podStatus?.hushhId) {
      fail(CLASS.DOMAIN, "The agent reports active but carries no HusshID, so no turn can be addressed.");
    }
    log(`pod active hushhId=${podStatus.hushhId} -- record this: it is the only handle a manual teardown has.`);

    // -------------------------------------------------------------------------
    // PHASE G -- the payoff. One turn, and the single assertion the exercise exists for.
    // -------------------------------------------------------------------------
    await step("turn-on-user-adc", async () => {
      const deadline = Date.now() + turnWaitMs;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const { status, payload } = await authoritative(
          `/api/one/u/${encodeURIComponent(podStatus.hushhId)}/turn`,
          {
            method: "POST",
            // No runtimeCredential and no pkmContext, deliberately. A credential
            // riding the turn would resolve runtimeMode to "byok" and the run would
            // pass while proving nothing about the customer's own Vertex access. No
            // consent token either: the relay mints the pkm.read grant server-side.
            body: { message: turnMessage, conversationId: "byoc-first-light" },
          }
        );

        if (status === 200) {
          const runtimeMode = String(payload?.runtimeMode || "");
          // THE ASSERTION. `_resolve_runtime_mode` resolves byok -> user_adc ->
          // hushh_managed_vertex (pod_turn.py:294-325), and a pod whose user-ADC
          // flag failed to render falls through to managed and answers NORMALLY --
          // same text, same model, same provider -- while spending hushh's identity
          // and leaving the customer's project idle. Treating any 200 as success
          // would pass on precisely the failure BYOC exists to prevent.
          if (runtimeMode !== "user_adc") {
            fail(
              CLASS.TURN_FAILED,
              runtimeMode === "hushh_managed_vertex"
                ? "The pod answered on hushh_managed_vertex: it is spending hushh's identity while the customer's project sits idle. This is the exact failure BYOC exists to prevent, and nothing in the answer text would reveal it."
                : `The pod answered on runtimeMode="${runtimeMode}"; only user_adc proves the turn ran on the customer's own Vertex ADC.`
            );
          }
          // Lengths and booleans only: the answer is model output on someone's
          // agent and has no business in a log. `grounded: false` with no
          // projection sent is correct and honest, not a defect.
          log(
            `turn runtimeMode=user_adc model=${payload?.model || "unknown"} provider=${payload?.provider || "unknown"} grounded=${payload?.grounded === true} text_chars=${String(payload?.text || "").length} attempts=${attempt}`
          );
          return;
        }

        const detail = payload?.detail;
        const code = typeof detail === "object" && detail ? String(detail.code || "") : "";
        const retriable =
          status === 503 || code === "AGENT_NOT_READY" || /not answering right now/i.test(String(detail || ""));
        if (!retriable || Date.now() >= deadline) {
          if (code === "AGENT_NOT_READY") {
            fail(
              CLASS.POD_NOT_READY,
              `The relay still refuses with AGENT_NOT_READY (status=${typeof detail === "object" ? detail.status : "unknown"}) after ${Math.round(turnWaitMs / 1000)}s.`
            );
          }
          if (status === 503) {
            // A cold economy pod is ~150s. Past the budget it is not cold, it is not
            // serving -- most often a revision that never pulled its image or never
            // booted its workers.
            fail(
              CLASS.POD_IMAGE_PULL,
              `The pod never answered within ${Math.round(turnWaitMs / 1000)}s. Check the revision in ${byocProjectId} for an image-pull failure (the pod image is pulled cross-project from the hub's Artifact Registry) or workers dying on import; gunicorn binds its port before its workers boot, so Ready=True proves nothing.`
            );
          }
          fail(CLASS.TURN_FAILED, `The turn failed with HTTP ${status}${code ? ` (${code})` : ""}.`);
        }
        log(`turn not ready yet (HTTP ${status}${code ? ` ${code}` : ""}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    });

    capture.assertNoCriticalApiFailures("byoc live journey");
    log(
      `LIVE PASS cloud_authorized=1 provisioning_scheduled=1 pod_active=1 turn_runtime_mode=user_adc project=${byocProjectId} hushhId=${podStatus.hushhId}`
    );
    // Said at the end because it is the moment someone is most likely to "clean up"
    // by calling deprovision, which is the single worst available action here.
    log(
      "teardown: do NOT call /api/one/personal-agent/deprovision on a shared fixture -- it writes an append-only tombstone, which burns this HusshID generation, so the next run builds a SECOND complete resource set beside this one and orphans it."
    );
    log(
      `teardown: deprovision would delete only the Cloud Run service. Inventory ${byocProjectId} for one-pod-* and one-mail-* resources, the <sa-id>-signing-key secret, and the project-level roles/aiplatform.user binding, and remove them by hand. A KMS key cannot be deleted at all.`
    );
  }
} catch (error) {
  exitCode = 1;
  if (error instanceof JourneyError) {
    log(`FAIL class=${error.failureClass} step=${error.step} detail=${error.message}`);
  } else {
    log(`FAIL class=${CLASS.DOMAIN} step=${currentStep} detail=${String(error?.message || error)}`);
  }
} finally {
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

process.exit(exitCode);
