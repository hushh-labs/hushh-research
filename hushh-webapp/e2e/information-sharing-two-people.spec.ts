import fs from "node:fs";
import path from "node:path";

import {
  expect,
  test,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import {
  createProtectedReviewerHarness,
  reviewerIdentityFromEnv,
  waitForReviewerVault,
  type ReviewerIdentity,
} from "./helpers/reviewer-session";
import {
  assertCleanupComplete,
  validateCleanupBundle,
} from "./helpers/information-sharing-cleanup";

/**
 * Two real people, isolated reviewer contexts, one information request.
 *
 * The primary reviewer OWNS the records; the counterpart REQUESTS them. That
 * assignment is fixed for the whole file so every assertion reads the same
 * way: "owner" decides in the Consent Center or in chat, "requester" asks on
 * the owner's /people page and opens what was granted.
 *
 * Gated exactly like agent-action-dispatch-consent.spec.ts: skipped unless
 * both identities, the reveal key and explicit mutation opt-ins are present.
 * No push is ever waited on. The chat surface is fed the same CustomEvent the
 * FCM service dispatches on a real message, and every state assertion reads
 * the Consent Center list endpoint the page itself calls.
 *
 * Env (values are never logged):
 *   REVIEWER_UID / REVIEWER_VAULT_PASSPHRASE              the owner
 *   REVIEWER_COUNTERPART_UID / REVIEWER_COUNTERPART_VAULT_PASSPHRASE
 *                                                          the requester
 *   E2E_COUNTERPART_PERSON_REF   the owner's public person reference, i.e.
 *                                the /people/<ref> segment the requester opens
 *   E2E_EXPECTED_GRANT_KEY       a key that exists in the owner's record for
 *                                the first requested item; nothing about the
 *                                record is hardcoded here
 *   E2E_REVIEWER_SIGNIN=1  E2E_INFORMATION_SHARING=1
 *   REVIEWER_ALLOW_SHARED_MUTATIONS=true
 *   E2E_LIVE_MODEL=1             lifts the Flow B fixme: the requester asks
 *                                through the private agent, which needs a
 *                                stack whose model actually answers a turn
 */

const REQUIRED_VALUES = [
  "REVIEWER_UID",
  "REVIEWER_VAULT_PASSPHRASE",
  "REVIEWER_COUNTERPART_UID",
  "REVIEWER_COUNTERPART_VAULT_PASSPHRASE",
  "E2E_COUNTERPART_PERSON_REF",
  "E2E_EXPECTED_GRANT_KEY",
] as const;

function hasTwoPeopleAuthority() {
  if (!REQUIRED_VALUES.every((key) => Boolean(process.env[key]?.trim()))) {
    return false;
  }
  return (
    process.env.E2E_REVIEWER_SIGNIN === "1" &&
    process.env.E2E_INFORMATION_SHARING === "1" &&
    process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true"
  );
}

/**
 * Same string the FCM service dispatches on a real push
 * (lib/notifications/fcm-service.ts). Copied rather than imported so the
 * spec does not pull Firebase into the Node runner; the check below fails the
 * proof the day the two drift instead of letting a renamed event pass as
 * "no card, no bug".
 */
const FCM_MESSAGE_EVENT = "fcm-message";

function assertFcmEventNameMatchesSource() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "notifications", "fcm-service.ts"),
    "utf8",
  );
  expect(
    source,
    "FCM_MESSAGE_EVENT in lib/notifications/fcm-service.ts no longer matches this spec",
  ).toContain(`export const FCM_MESSAGE_EVENT = "${FCM_MESSAGE_EVENT}";`);
}

/** The first N items the proof needs: center approve, chat approve, deny. */
const ITEMS_NEEDED = 3;
const REQUESTED_HOURS = 72;
/** How the Consent Center labels a 72 hour window in its duration control. */
const REQUESTED_HOURS_LABEL = "3 days";
/**
 * How long a Consent Center read is retried before the proof gives up. The
 * backend answers synchronously, so this only absorbs a slow stack.
 */
const CENTER_SETTLE_MS = 30_000;

type RequestBundle = {
  bundleId: string;
  items: Array<{
    requestId: string;
    scopeRef: string;
    label: string;
    status: string;
  }>;
};

type CenterSurface = "pending" | "active" | "previous";

/**
 * The `?tab=` value the Consent Center page reads for each list surface
 * (normalizeTab in consent-center-page.tsx). "pending" is not a tab name; it
 * only lands on the requests tab because that is the fallback.
 */
const CENTER_TAB: Record<CenterSurface, "requests" | "active" | "history"> = {
  pending: "requests",
  active: "active",
  previous: "history",
};

/**
 * Status vocabulary per surface, read from
 * consent-protocol/hushh_mcp/services/consent_center_service.py:
 *
 *   pending   `_normalize_pending` hardcodes "pending".
 *   active    `_normalize_active` hardcodes "active". "approved" never
 *             appears here; it is what `_map_action_to_status` makes of a
 *             CONSENT_GRANTED ledger row, i.e. a history word.
 *   previous  `_normalize_history` runs the ledger action through
 *             `_map_action_to_status`: CONSENT_DENIED -> "denied",
 *             REVOKED -> "revoked", CANCELLED -> "cancelled" (and
 *             REQUESTED -> "request_pending", EXPORT_READ -> "opened" for
 *             the rows around them).
 */
type CenterStatus = "pending" | "active" | "denied" | "revoked" | "cancelled";

/**
 * What a Consent Center tab sent on its own list call: the bearer that
 * proves the identity and the exact URL shape the page uses.
 */
type CenterAuth = {
  authorization: string;
  listUrl: URL;
};

const ownerIdentity = reviewerIdentityFromEnv(
  "REVIEWER_UID",
  "REVIEWER_VAULT_PASSPHRASE",
);
const requesterIdentity = reviewerIdentityFromEnv(
  "REVIEWER_COUNTERPART_UID",
  "REVIEWER_COUNTERPART_VAULT_PASSPHRASE",
);
const ownerPersonRef = process.env.E2E_COUNTERPART_PERSON_REF?.trim() ?? "";
const expectedGrantKey = process.env.E2E_EXPECTED_GRANT_KEY?.trim() ?? "";
const ownerPeopleRoute = `/people/${encodeURIComponent(ownerPersonRef)}`;
type ReviewerHarness = Awaited<
  ReturnType<typeof createProtectedReviewerHarness>
>;
type ReviewerSession = Awaited<ReturnType<ReviewerHarness["openSession"]>>;
const pageHarness = new WeakMap<Page, ReviewerHarness>();
const pageCommitments = new WeakMap<
  Page,
  { session: ReviewerSession; commitment: string }
>();
const centerAuthByPage = new WeakMap<Page, CenterAuth>();
async function navigateProtected(page: Page, href: string) {
  const harness = pageHarness.get(page);
  if (!harness) throw new Error("Protected page has no reviewer harness");
  await harness.navigateInApp(page, href);
  const initial = pageCommitments.get(page);
  if (!initial) throw new Error("Protected page has no initial key commitment");
  const current = harness.vaultKeyCommitment(
    await initial.session.capture.vaultState(),
  );
  expect(
    current === initial.commitment,
    "protected navigation preserves the vault key commitment",
  ).toBe(true);
}

function pathEndsWith(response: Response, suffix: string): boolean {
  return new URL(response.url()).pathname.endsWith(suffix);
}

function waitForJsonResponse(
  page: Page,
  method: string,
  pathSuffix: string,
  timeout = 60_000,
): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      pathEndsWith(response, pathSuffix),
    { timeout },
  );
}

/**
 * Open a Consent Center tab and capture what the page itself sent on its
 * list call for that surface. The page's payload is deliberately NOT read:
 * app/api/consent/center/list/route.ts keeps a 30 s hot cache keyed on the
 * query string plus the bearer, and nothing invalidates it on a decision, so
 * a proof that trusted the page's fetch could read the state from before the
 * tap it just made. The direct reads below carry a nonce instead.
 */
async function openCenterTab(
  page: Page,
  identity: ReviewerIdentity,
  surface: CenterSurface,
): Promise<CenterAuth> {
  const tab = CENTER_TAB[surface];
  const cached = centerAuthByPage.get(page);
  if (cached) {
    await navigateProtected(page, `/one/consent?tab=${tab}`);
    return cached;
  }
  const requestPromise = page.waitForRequest(
    (request) => {
      if (request.method() !== "GET") return false;
      const url = new URL(request.url());
      return (
        url.pathname.endsWith("/api/consent/center/list") &&
        url.searchParams.get("surface") === surface &&
        url.searchParams.has("page")
      );
    },
    { timeout: 60_000 },
  );
  await navigateProtected(page, `/one/consent?tab=${tab}`);
  await waitForReviewerVault(page, identity);
  const request = await requestPromise;
  const authorization = request.headers()["authorization"] ?? "";
  expect(
    authorization.startsWith("Bearer "),
    "the Consent Center sends a bearer on center/list",
  ).toBe(true);
  const auth = { authorization, listUrl: new URL(request.url()) };
  centerAuthByPage.set(page, auth);
  return auth;
}

/**
 * Read one surface straight from the list endpoint with the page's own
 * bearer. The nonce makes every read a fresh key for the route's hot cache;
 * FastAPI ignores the extra query parameter. The page size is widened so a
 * busy reviewer fixture cannot push this run's request onto page two.
 */
async function fetchCenterSurface(
  page: Page,
  auth: CenterAuth,
  surface: CenterSurface,
): Promise<unknown> {
  const url = new URL(auth.listUrl.toString());
  url.searchParams.set("surface", surface);
  url.searchParams.set("page", "1");
  url.searchParams.set("limit", "100");
  url.searchParams.set(
    "nonce",
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const response = await page.request.get(url.toString(), {
    headers: { Authorization: auth.authorization },
  });
  expect(response.status(), `center/list surface=${surface}`).toBe(200);
  return response.json();
}

/**
 * Keys under which the list payload keeps a request's HISTORY rather than its
 * state: `_collapse_consent_chains` writes `consent_chain`, and
 * `_group_history_identifier_trails` writes `consent_trails[].events`. Each
 * event there is one ledger row ("request_pending", then "approved", then
 * "revoked"...), so reading them would let an old word satisfy the proof.
 * `metadata` is the request's wire metadata (it repeats the chain ids) and
 * carries no state either.
 */
const HISTORY_EVENT_KEYS = new Set(["consent_chain", "events", "metadata"]);

/**
 * Every CURRENT `status` the list payload records against a request id:
 *
 *   - a flat pending or active entry (`request_id`, `id`),
 *   - a collapsed chain on the pending/active surfaces (`chain_request_ids`,
 *     `latest_request_id`, one status for the whole chain),
 *   - a trail on the previous surface (`request_ids`, `latest_request_id`,
 *     status = the newest transition of that request's lifecycle),
 *   - the identifier row that groups the trails, but only through its own
 *     `request_id` / `latest_request_id`: its `chain_request_ids` name the
 *     newest trail while its status is the newest transition overall, and
 *     those can belong to different requests.
 *
 * Event arrays are skipped (see HISTORY_EVENT_KEYS). The payload nests by
 * counterpart on the history surface, so a walk is the robust read.
 */
function collectRequestStatuses(
  node: unknown,
  requestId: string,
  out: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) collectRequestStatuses(child, requestId, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  const directIds = [record.request_id, record.id, record.latest_request_id]
    .filter((value) => typeof value === "string")
    .map(String);
  const isIdentifierRow = Array.isArray(record.consent_trails);
  const listedIds = [
    ...(Array.isArray(record.request_ids) ? record.request_ids : []),
    ...(!isIdentifierRow && Array.isArray(record.chain_request_ids)
      ? record.chain_request_ids
      : []),
  ].map(String);
  if (
    (directIds.includes(requestId) || listedIds.includes(requestId)) &&
    typeof record.status === "string"
  ) {
    out.add(record.status.trim().toLowerCase());
  }
  for (const [key, value] of Object.entries(record)) {
    if (HISTORY_EVENT_KEYS.has(key)) continue;
    collectRequestStatuses(value, requestId, out);
  }
  return out;
}

async function readRequestStatuses(
  page: Page,
  auth: CenterAuth,
  surface: CenterSurface,
  requestId: string,
): Promise<string[]> {
  const payload = await fetchCenterSurface(page, auth, surface);
  return [...collectRequestStatuses(payload, requestId)];
}

/** Poll a surface until the request carries the expected status. */
async function expectSurfaceStatus(
  page: Page,
  auth: CenterAuth,
  surface: CenterSurface,
  requestId: string,
  expected: CenterStatus,
): Promise<void> {
  await expect
    .poll(() => readRequestStatuses(page, auth, surface, requestId), {
      timeout: CENTER_SETTLE_MS,
      message: `request ${requestId} on surface=${surface} should carry status ${expected}`,
    })
    .toContain(expected);
}

/** Poll a surface until the request no longer appears on it at all. */
async function expectSurfaceAbsent(
  page: Page,
  auth: CenterAuth,
  surface: CenterSurface,
  requestId: string,
): Promise<void> {
  await expect
    .poll(() => readRequestStatuses(page, auth, surface, requestId), {
      timeout: CENTER_SETTLE_MS,
      message: `request ${requestId} should have left surface=${surface}`,
    })
    .toHaveLength(0);
}

/** Open the matching tab, then assert the status through a fresh read. */
async function expectCenterStatus(
  page: Page,
  identity: ReviewerIdentity,
  surface: CenterSurface,
  requestId: string,
  expected: CenterStatus,
): Promise<CenterAuth> {
  const auth = await openCenterTab(page, identity, surface);
  await expectSurfaceStatus(page, auth, surface, requestId, expected);
  return auth;
}

async function readSelectedCount(page: Page): Promise<number> {
  const label = await page
    .locator('[data-voice-control-id="person-profile-review-information"]')
    .innerText();
  const match = /\((\d+)\)/.exec(label);
  return match ? Number(match[1]) : 0;
}

/**
 * Tick at least `minimum` requestable references. Leaves at the root of the
 * catalogue are taken first; when the root is folders, whole folders are
 * taken until the counter on the Review button reaches the minimum. Returns
 * how many are selected. Nothing about the catalogue's shape is assumed.
 */
async function selectRequestScopes(
  page: Page,
  minimum: number,
): Promise<number> {
  const available = page.getByTestId("person-profile-available");
  await expect(available).toBeVisible({ timeout: 60_000 });
  const leafToggles = available.locator(
    '[data-testid^="person-profile-scope-toggle-"]',
  );
  const groupToggles = available.locator(
    '[data-testid^="person-profile-scope-group-toggle-"]',
  );
  await expect(leafToggles.or(groupToggles).first()).toBeVisible({
    timeout: 30_000,
  });

  let selected = 0;
  const leafCount = await leafToggles.count();
  for (let index = 0; index < leafCount && selected < minimum; index += 1) {
    await leafToggles.nth(index).check();
    selected = await readSelectedCount(page);
  }
  const groupCount = await groupToggles.count();
  for (let index = 0; index < groupCount && selected < minimum; index += 1) {
    await groupToggles.nth(index).check();
    selected = await readSelectedCount(page);
  }
  return selected;
}

/**
 * Requester side: open the owner's page, tick references, ask for 72 hours
 * with the given purpose, and return the bundle the backend answered with.
 */
async function composeRequest(
  page: Page,
  purpose: string,
): Promise<RequestBundle> {
  await navigateProtected(page, `${ownerPeopleRoute}?request=1`);
  await waitForReviewerVault(page, requesterIdentity!);

  const selected = await selectRequestScopes(page, ITEMS_NEEDED);
  expect(
    selected,
    `the owner's catalogue must offer at least ${ITEMS_NEEDED} requestable references`,
  ).toBeGreaterThanOrEqual(ITEMS_NEEDED);

  await page
    .locator('[data-voice-control-id="person-profile-review-information"]')
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByTestId("person-profile-duration-select")
    .selectOption(String(REQUESTED_HOURS));
  await page.getByTestId("person-profile-purpose").fill(purpose);

  const created = waitForJsonResponse(
    page,
    "POST",
    "/api/one/information-requests",
  );
  await page
    .locator('[data-voice-control-id="person-profile-request-confirm"]')
    .click();
  const response = await created;
  expect(response.status(), "POST /api/one/information-requests").toBe(200);
  const bundle = (await response.json()) as RequestBundle;
  expect(bundle.bundleId).toBeTruthy();
  expect(bundle.items.length).toBeGreaterThanOrEqual(ITEMS_NEEDED);
  for (const item of bundle.items) {
    expect(item.status, `item ${item.requestId} starts pending`).toBe(
      "pending",
    );
  }
  // The page refetches its viewer profile after sending; the purpose is the
  // one string unique to this run, so its row is the proof the request landed.
  await expect(page.getByText(purpose, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  return bundle;
}

/**
 * The Request history rows (one per requested item) that carry this purpose.
 *
 * The row in person-profile-page.tsx has no test id of its own, and the spec
 * adds none. The nearest stable anchor is the section's
 * `aria-labelledby="request-history"`; inside it the rows are the direct
 * children of the one `divide-y` list (`div.divide-y > div`). Filtering those
 * rows, rather than every ancestor `div` that happens to contain the purpose,
 * is what keeps the Cancel below scoped to this request's row and not to the
 * whole page.
 */
function historyRowsFor(page: Page, purpose: string) {
  return page
    .locator('section[aria-labelledby="request-history"] div.divide-y > div')
    .filter({ has: page.getByText(purpose, { exact: true }) });
}

/** The Cancel controls still offered on this purpose's rows. */
function cancelButtonsFor(page: Page, purpose: string) {
  return historyRowsFor(page, purpose).getByRole("button", {
    name: "Cancel",
    exact: true,
  });
}

/**
 * Withdraw the bundle from its own row. Cancel is per bundle in
 * PersonProfileService.cancelInformationRequest, so the wait is pinned to
 * that bundle's cancel path and every row of the purpose loses its control.
 */
async function cancelRequestByPurpose(
  page: Page,
  purpose: string,
  bundleId: string,
): Promise<void> {
  const rows = historyRowsFor(page, purpose);
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const cancelPath = `/api/one/information-requests/${encodeURIComponent(bundleId)}/cancel`;
  const cancelled = waitForJsonResponse(page, "POST", cancelPath);
  await cancelButtonsFor(page, purpose).first().click();
  const response = await cancelled;
  expect(response.status(), `POST ${cancelPath}`).toBe(200);
  // The page refetches the viewer profile after cancelling.
  await expect(cancelButtonsFor(page, purpose)).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(rows.first()).not.toContainText("pending");
}

/** Feed the chat surface what the FCM service would on a real push. */
async function dispatchFcm(
  page: Page,
  data: Record<string, string>,
): Promise<void> {
  await page.evaluate(
    ({ eventName, detail }) => {
      window.dispatchEvent(
        new CustomEvent(eventName, { detail: { data: detail } }),
      );
    },
    { eventName: FCM_MESSAGE_EVENT, detail: data },
  );
}

async function openChat(page: Page, identity: ReviewerIdentity): Promise<void> {
  await navigateProtected(page, "/");
  await waitForReviewerVault(page, identity);
  await expect(page.getByTestId("agent-chat-composer")).toBeVisible({
    timeout: 60_000,
  });
  await page
    .getByRole("button", { name: "Create new Agent chat", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.getByTestId("specialist-pending-consent-request-card"),
  ).toHaveCount(0);
}

test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial", retries: 0, timeout: 300_000 });

test.describe("Information sharing between two people (real backend, no push)", () => {
  test.skip(
    !hasTwoPeopleAuthority(),
    "needs both reviewer pairs, owner public reference, expected grant key, sign-in/proof opt-ins and REVIEWER_ALLOW_SHARED_MUTATIONS=true",
  );
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "two-context proof runs on chromium only",
  );

  const runNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const purposeA = `Two-people proof A ${runNonce}: check what sharing looks like end to end.`;
  const purposeB = `Two-people proof B ${runNonce}: withdrawn before the owner decides.`;
  const purposeC = `Two-people proof C ${runNonce}: asked through the private agent.`;

  let ownerPage: Page;
  let ownerChat: Page;
  let requesterPage: Page;
  let bundle: RequestBundle;
  const opened: ReviewerSession[] = [];
  let ownerHarness: Awaited<ReturnType<typeof createProtectedReviewerHarness>>;
  let requesterHarness: Awaited<
    ReturnType<typeof createProtectedReviewerHarness>
  >;
  const receipts = new Map<string, RequestBundle>();
  const receiptReads: Promise<void>[] = [];
  type CreationAttempt = {
    purpose: string;
    scopeRefs: string[];
    durationSeconds: number;
    sentAt: number;
    ownerAuthorization: string;
    bundleId?: string;
  };
  const attempts = new Map<string, CreationAttempt>();
  const requestAttempts = new WeakMap<Request, CreationAttempt>();
  const captureFailures: string[] = [];
  let requesterSession: ReviewerSession;

  test.beforeAll(async ({ browser }, testInfo) => {
    assertFcmEventNameMatchesSource();
    expect(
      ownerIdentity!.userId === requesterIdentity!.userId,
      "reviewers must be distinct",
    ).toBe(false);
    const origin = testInfo.project.use.baseURL!;
    ownerHarness = await createProtectedReviewerHarness(ownerIdentity!, origin);
    requesterHarness = await createProtectedReviewerHarness(
      requesterIdentity!,
      origin,
    );
    await ownerHarness.assertVisibleVaultChallenge(browser, "/one/consent");
    const owner = await ownerHarness.openSession(browser, "/one/consent");
    opened.push(owner);
    ownerPage = owner.page;
    pageHarness.set(ownerPage, ownerHarness);
    const requester = await requesterHarness.openSession(
      browser,
      ownerPeopleRoute,
    );
    opened.push(requester);
    requesterSession = requester;
    requesterPage = requester.page;
    pageHarness.set(requesterPage, requesterHarness);
    requesterPage.on("request", (request) => {
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/one/information-requests"
      )
        return;
      try {
        const body = request.postDataJSON();
        if (
          body.person_ref !== ownerPersonRef ||
          ![purposeA, purposeB, purposeC].includes(body.purpose) ||
          !Array.isArray(body.scope_refs) ||
          body.scope_refs.length < 1 ||
          body.scope_refs.length > 50 ||
          !body.scope_refs.every(
            (scope: unknown) => typeof scope === "string",
          ) ||
          typeof body.idempotency_key !== "string" ||
          typeof body.duration_seconds !== "number"
        )
          throw new Error("unrecognized creation");
        const prior = attempts.get(body.idempotency_key);
        if (
          prior &&
          (prior.purpose !== body.purpose ||
            prior.durationSeconds !== body.duration_seconds ||
            JSON.stringify(prior.scopeRefs) !==
              JSON.stringify([...body.scope_refs].sort()))
        )
          throw new Error("idempotency collision");
        const attempt = prior ?? {
          purpose: body.purpose,
          scopeRefs: [...body.scope_refs].sort(),
          durationSeconds: body.duration_seconds,
          sentAt: Date.now(),
          ownerAuthorization: request.headers().authorization ?? "",
        };
        if (attempts.size >= 3 && !prior)
          throw new Error("unexpected extra creation");
        attempts.set(body.idempotency_key, attempt);
        requestAttempts.set(request, attempt);
      } catch {
        captureFailures.push(
          "unrecognized creation attempt; manual reconciliation required",
        );
      }
    });
    requesterPage.on("response", (response) => {
      if (
        response.request().method() !== "POST" ||
        !pathEndsWith(response, "/api/one/information-requests") ||
        !response.ok()
      )
        return;
      const read = response.json().then((created: RequestBundle) => {
        const attempt = requestAttempts.get(response.request());
        if (!attempt)
          throw new Error("Creation has no recognized outgoing attempt");
        if (!created.bundleId || !Array.isArray(created.items))
          throw new Error("Invalid creation receipt");
        if (
          created.items.length !== attempt.scopeRefs.length ||
          JSON.stringify(created.items.map((item) => item.scopeRef).sort()) !==
            JSON.stringify(attempt.scopeRefs) ||
          !created.items.every(
            (item) =>
              typeof item.requestId === "string" && item.requestId.length > 0,
          )
        )
          throw new Error("Creation receipt does not match request");
        receipts.set(created.bundleId, created);
        attempt.bundleId = created.bundleId;
      });
      void read.catch(() => undefined);
      receiptReads.push(read);
    });
    const chat = await ownerHarness.openSession(browser, "/");
    opened.push(chat);
    ownerChat = chat.page;
    pageHarness.set(ownerChat, ownerHarness);
    for (const session of opened) {
      const harness = pageHarness.get(session.page)!;
      pageCommitments.set(session.page, {
        session,
        commitment: harness.vaultKeyCommitment(
          await session.capture.vaultState(),
        ),
      });
    }
  });

  test.afterAll(async () => {
    const cleanupFailures: string[] = [...captureFailures];
    try {
      const readResults = await Promise.allSettled(receiptReads);
      for (const result of readResults) {
        if (result.status === "rejected")
          cleanupFailures.push(
            "creation receipt could not be decoded; outcome requires reconciliation",
          );
      }
      for (const attempt of attempts.values()) {
        if (attempt.bundleId) continue;
        try {
          // Authenticated profile history is constrained to this requester and owner.
          const identity = await openCenterTab(
            requesterPage,
            requesterIdentity!,
            "pending",
          );
          const historyResponse = await requesterPage.request.get(
            `/api/one/people/${encodeURIComponent(ownerPersonRef)}`,
            {
              headers: {
                Authorization: identity.authorization,
                "Cache-Control": "no-cache",
              },
            },
          );
          if (!historyResponse.ok()) throw new Error("history unavailable");
          const { requestHistory } = await historyResponse.json();
          if (!Array.isArray(requestHistory) || requestHistory.length >= 100)
            throw new Error("history may be truncated");
          const matches = requestHistory.filter(
            (item) =>
              item.purpose === attempt.purpose &&
              Date.parse(item.createdAt) >= attempt.sentAt - 5_000 &&
              Date.parse(item.createdAt) <= Date.now(),
          );
          const bundleIds = [...new Set(matches.map((item) => item.bundleId))];
          if (bundleIds.length !== 1 || typeof bundleIds[0] !== "string")
            throw new Error("ambiguous or missing creation");
          const detailResponse = await requesterPage.request.get(
            `/api/one/information-requests/${encodeURIComponent(bundleIds[0])}`,
            {
              headers: { Authorization: attempt.ownerAuthorization },
            },
          );
          if (!detailResponse.ok())
            throw new Error("bundle verification failed");
          const detail = await detailResponse.json();
          if (
            detail.bundleId !== bundleIds[0] ||
            detail.personRef !== ownerPersonRef ||
            detail.purpose !== attempt.purpose ||
            detail.durationSeconds !== attempt.durationSeconds ||
            !Array.isArray(detail.items) ||
            detail.items.length !== attempt.scopeRefs.length ||
            JSON.stringify(
              detail.items
                .map((item: { scopeRef: string }) => item.scopeRef)
                .sort(),
            ) !== JSON.stringify(attempt.scopeRefs) ||
            !detail.items.every(
              (item: { requestId: unknown }) =>
                typeof item.requestId === "string" &&
                matches.some((row) => row.requestId === item.requestId),
            )
          ) {
            throw new Error("bundle is not the bounded outgoing attempt");
          }
          attempt.bundleId = detail.bundleId;
          receipts.set(detail.bundleId, detail);
        } catch {
          cleanupFailures.push(
            "lost creation receipt could not be reconciled unambiguously; no unknown bundle changed",
          );
        }
      }
      for (const receipt of receipts.values()) {
        const attempt = [...attempts.values()].find(
          (entry) => entry.bundleId === receipt.bundleId,
        );
        if (!attempt) {
          cleanupFailures.push("receipt has no recognized creation attempt");
          continue;
        }
        let ownerAuthorization: string;
        try {
          ownerAuthorization = attempt.ownerAuthorization || `Bearer ${await requesterSession.capture.ownerToken()}`;
        } catch {
          cleanupFailures.push("requester owner authorization unavailable; bundle left unchanged");
          continue;
        }
        const detailPath = `/api/one/information-requests/${encodeURIComponent(receipt.bundleId)}`;
        const expectedBundle = {
          ...receipt,
          personRef: ownerPersonRef,
          purpose: attempt.purpose,
        };
        const readDetail = async () => {
          const response = await requesterPage.request.get(detailPath, {
            headers: { Authorization: ownerAuthorization },
          });
          if (!response.ok())
            throw new Error("authoritative cleanup detail unavailable");
          return response.json();
        };
        let grantedItems;
        try {
          grantedItems = validateCleanupBundle(
            await readDetail(),
            expectedBundle,
          ).items.filter((item) => item.status === "granted");
        } catch {
          cleanupFailures.push(
            "authoritative cleanup detail unavailable; bundle left unchanged",
          );
          continue;
        }
        for (const item of grantedItems) {
          try {
            await navigateProtected(
              ownerPage,
              `/one/consent?tab=active&requestId=${encodeURIComponent(item.requestId)}`,
            );
            await ownerPage
              .locator('[data-voice-control-id="consent_revoke"]')
              .click();
            const revoked = waitForJsonResponse(
              ownerPage,
              "POST",
              "/api/consent/revoke",
            );
            await ownerPage
              .getByRole("alertdialog")
              .getByRole("button", { name: "Stop sharing" })
              .click();
            if ((await revoked).status() !== 200)
              throw new Error("revoke refused");
            const refreshed = validateCleanupBundle(
              await readDetail(),
              expectedBundle,
            );
            if (
              refreshed.items.some(
                (row) =>
                  row.requestId === item.requestId && row.status === "granted",
              )
            )
              throw new Error("grant remains after revoke");
          } catch {
            cleanupFailures.push("run-owned grant revocation failed");
          }
        }
        try {
          // Cancellation skips already decided items and removes leftovers.
          const cancelled = await requesterPage.request.post(
            `/api/one/information-requests/${encodeURIComponent(receipt.bundleId)}/cancel`,
            { headers: { Authorization: ownerAuthorization } },
          );
          if (!cancelled.ok()) throw new Error("cancel refused");
          // A 200 cancellation skips granted items; only this fresh read proves cleanup.
          assertCleanupComplete(await readDetail(), expectedBundle);
        } catch {
          cleanupFailures.push("run-owned request cancellation failed");
        }
      }
      for (const session of opened) {
        session.capture.assertNoCriticalApiFailures("two-person proof");
        session.readOnlyGuard.assertNoBlockedMutation();
      }
      expect(cleanupFailures, "fixture cleanup must complete").toEqual([]);
    } finally {
      await Promise.all(opened.map((session) => session.context.close()));
    }
  });

  test("requester asks the owner for three items with a 72 hour window", async () => {
    bundle = await composeRequest(requesterPage, purposeA);
  });

  test("owner allows the first item from the Consent Center at the requested 72 hours", async () => {
    const [first] = bundle.items;
    await navigateProtected(
      ownerPage,
      `/one/consent?tab=${CENTER_TAB.pending}&requestId=${encodeURIComponent(first!.requestId)}`,
    );
    await waitForReviewerVault(ownerPage, ownerIdentity!);

    const duration = ownerPage.getByRole("combobox", {
      name: "Access duration",
    });
    await expect(duration).toBeVisible({ timeout: 60_000 });
    await expect(duration).toContainText(REQUESTED_HOURS_LABEL);

    const approved = waitForJsonResponse(
      ownerPage,
      "POST",
      "/api/consent/pending/approve",
    );
    await ownerPage
      .locator('[data-voice-control-id="consent_approve"]')
      .click();
    expect((await approved).status(), "POST /api/consent/pending/approve").toBe(
      200,
    );

    const auth = await expectCenterStatus(
      ownerPage,
      ownerIdentity!,
      "active",
      first!.requestId,
      "active",
    );
    await expectSurfaceAbsent(ownerPage, auth, "pending", first!.requestId);
  });

  test("owner allows the second item from the chat card the push would have raised (D1)", async () => {
    const second = bundle.items[1]!;
    await openChat(ownerChat, ownerIdentity!);

    const lookedUp = waitForJsonResponse(
      ownerChat,
      "GET",
      "/api/consent/pending/lookup",
    );
    await dispatchFcm(ownerChat, {
      type: "consent_request",
      request_id: second.requestId,
      bundle_id: bundle.bundleId,
    });
    expect((await lookedUp).status(), "GET /api/consent/pending/lookup").toBe(
      200,
    );

    const card = ownerChat.getByTestId(
      "specialist-pending-consent-request-card",
    );
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card).toContainText("wants to see");
    const approveButton = ownerChat.getByTestId(
      "specialist-pending-consent-approve",
    );
    await expect(approveButton).toBeVisible();

    const approved = waitForJsonResponse(
      ownerChat,
      "POST",
      "/api/consent/pending/approve",
    );
    await approveButton.click();
    expect((await approved).status(), "POST /api/consent/pending/approve").toBe(
      200,
    );
    await expect(card).toContainText("Approved");
    await expect(approveButton).toHaveCount(0);

    await expectCenterStatus(
      ownerPage,
      ownerIdentity!,
      "active",
      second.requestId,
      "active",
    );
  });

  test("owner declines the third item in the Consent Center and the chat card flips on the resolved signal", async () => {
    const third = bundle.items[2]!;
    // A new conversation leaves the approved card in its original history.
    await openChat(ownerChat, ownerIdentity!);
    const lookedUp = waitForJsonResponse(
      ownerChat,
      "GET",
      "/api/consent/pending/lookup",
    );
    await dispatchFcm(ownerChat, {
      type: "consent_request",
      request_id: third.requestId,
      bundle_id: bundle.bundleId,
    });
    expect((await lookedUp).status()).toBe(200);
    const card = ownerChat.getByTestId(
      "specialist-pending-consent-request-card",
    );
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(
      ownerChat.getByTestId("specialist-pending-consent-approve"),
    ).toBeVisible();

    await navigateProtected(
      ownerPage,
      `/one/consent?tab=${CENTER_TAB.pending}&requestId=${encodeURIComponent(third.requestId)}`,
    );
    await waitForReviewerVault(ownerPage, ownerIdentity!);
    const deny = ownerPage.locator('[data-voice-control-id="consent_deny"]');
    await expect(deny).toBeVisible({ timeout: 60_000 });
    await deny.click();
    await expect(deny).toHaveText("Sure?");
    const denied = waitForJsonResponse(
      ownerPage,
      "POST",
      "/api/consent/pending/deny",
    );
    await deny.click();
    expect((await denied).status(), "POST /api/consent/pending/deny").toBe(200);

    await dispatchFcm(ownerChat, {
      type: "consent_resolved",
      request_id: third.requestId,
      action: "CONSENT_DENIED",
    });
    await expect(card).toContainText("Denied");
    await expect(
      ownerChat.getByTestId("specialist-pending-consent-approve"),
    ).toHaveCount(0);

    await expectCenterStatus(
      ownerPage,
      ownerIdentity!,
      "previous",
      third.requestId,
      "denied",
    );
  });

  test("requester opens the granted record and finds the expected key", async () => {
    test.skip(
      !expectedGrantKey,
      "set E2E_EXPECTED_GRANT_KEY to a key present in the owner's first requested item",
    );
    const [first] = bundle.items;

    // The viewer profile is what the page renders "Shared with you" from, in
    // payload order, and it is the only place this run's requestId is visible;
    // the card itself carries a label that earlier runs may share.
    const viewerLoaded = requesterPage.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        decodeURIComponent(new URL(response.url()).pathname).endsWith(
          `/api/one/people/${ownerPersonRef}`,
        ),
      { timeout: 60_000 },
    );
    await navigateProtected(requesterPage, ownerPeopleRoute);
    await waitForReviewerVault(requesterPage, requesterIdentity!);
    const viewerResponse = await viewerLoaded;
    expect(viewerResponse.status(), "GET /api/one/people/<ref>").toBe(200);
    const viewer = (await viewerResponse.json()) as {
      grants?: Array<{ requestId?: string | null }>;
    };
    const grantIndex = (viewer.grants ?? []).findIndex(
      (grant) => grant.requestId === first!.requestId,
    );
    expect(
      grantIndex,
      "this run's first grant is listed under Shared with you",
    ).toBeGreaterThanOrEqual(0);

    const reveal = requesterPage
      .getByTestId("person-profile-grant-reveal")
      .nth(grantIndex);
    await expect(reveal).toBeVisible({ timeout: 60_000 });

    const exported = waitForJsonResponse(
      requesterPage,
      "GET",
      `/api/one/information-requests/${encodeURIComponent(bundle.bundleId)}/exports`,
    );
    await reveal.click();
    const exportsResponse = await exported;
    expect(
      exportsResponse.status(),
      "GET /api/one/information-requests/<bundle>/exports",
    ).toBe(200);
    const exportsPayload = (await exportsResponse.json()) as {
      exports?: Array<{ requestId?: string }>;
    };
    expect(
      (exportsPayload.exports ?? []).map((item) => item.requestId),
      "the opened bundle carries this run's first request",
    ).toContain(first!.requestId);

    // Exactly one card is open, and it is the one whose reveal was clicked.
    const value = requesterPage.getByTestId("person-profile-grant-value");
    await expect(value).toHaveCount(1, { timeout: 30_000 });
    // The key only; the decrypted value is never read out of the page.
    await expect
      .poll(
        () =>
          value.evaluate(
            (element, key) =>
              element.textContent?.includes(`"${key}"`) === true,
            expectedGrantKey,
          ),
        { message: "opened record contains the configured key" },
      )
      .toBe(true);
    await reveal.click();
    await expect(value).toHaveCount(0);
  });

  test("owner stops sharing the first item through the confirming dialog", async () => {
    const [first] = bundle.items;
    await navigateProtected(
      ownerPage,
      `/one/consent?tab=active&requestId=${encodeURIComponent(first!.requestId)}`,
    );
    await waitForReviewerVault(ownerPage, ownerIdentity!);
    const revoke = ownerPage.locator(
      '[data-voice-control-id="consent_revoke"]',
    );
    await expect(revoke).toBeVisible({ timeout: 60_000 });
    await revoke.click();

    const dialog = ownerPage.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const revoked = waitForJsonResponse(
      ownerPage,
      "POST",
      "/api/consent/revoke",
    );
    await dialog.getByRole("button", { name: "Stop sharing" }).click();
    expect((await revoked).status(), "POST /api/consent/revoke").toBe(200);

    await expectCenterStatus(
      ownerPage,
      ownerIdentity!,
      "previous",
      first!.requestId,
      "revoked",
    );
  });

  test("requester withdraws a second request and the owner sees it as cancelled", async () => {
    const second = await composeRequest(requesterPage, purposeB);
    await cancelRequestByPurpose(requesterPage, purposeB, second.bundleId);
    await expectCenterStatus(
      ownerPage,
      ownerIdentity!,
      "previous",
      second.items[0]!.requestId,
      "cancelled",
    );

    // Leave nothing pending behind: a folder pick can carry more than the
    // three items the proof decided on. Cancel skips already decided items.
    await navigateProtected(requesterPage, ownerPeopleRoute);
    await waitForReviewerVault(requesterPage, requesterIdentity!);
    await expect(historyRowsFor(requesterPage, purposeA).first()).toBeVisible({
      timeout: 30_000,
    });
    if ((await cancelButtonsFor(requesterPage, purposeA).count()) > 0) {
      await cancelRequestByPurpose(requesterPage, purposeA, bundle.bundleId);
    }
  });

  test("Flow B: the requester asks through the private agent (chat-driven consent.request)", async () => {
    test.fixme(
      process.env.E2E_LIVE_MODEL !== "1",
      "needs a live model turn: set E2E_LIVE_MODEL=1 against a stack whose private agent answers",
    );
    const [first] = bundle.items;

    // The name the private agent resolves the owner by is the public one.
    const publicProfile = await requesterPage.request.get(
      `/api/public/people/${encodeURIComponent(ownerPersonRef)}`,
    );
    expect(publicProfile.status(), "GET /api/public/people/<ref>").toBe(200);
    const { displayName } = (await publicProfile.json()) as {
      displayName?: string;
    };
    expect(displayName, "the owner has a public display name").toBeTruthy();

    const requesterChat = requesterPage;
    await openChat(requesterChat, requesterIdentity!);

    // The model proposes, the app confirms, and consent.request lands as
    // the same POST the /people composer makes. A model turn is slow.
    let createdEarly = false;
    const created = waitForJsonResponse(
      requesterChat,
      "POST",
      "/api/one/information-requests",
      270_000,
    ).then((response) => {
      createdEarly = true;
      return response;
    });
    // Keep a rejection observed if an earlier assertion fails.
    void created.catch(() => undefined);
    const composer = requesterChat.getByTestId("agent-chat-composer-textarea");
    const baseline = await requesterChat
      .locator('[data-message-role="assistant"]')
      .count();
    await composer.fill(
      `Ask ${displayName} to share their ${first!.label} with me for 3 days. Use this exact request purpose: ${purposeC}`,
    );
    await composer.press("Enter");
    await requesterChat.waitForFunction(
      (count) => {
        const turns = [
          ...document.querySelectorAll('[data-message-role="assistant"]'),
        ];
        const latest = turns.at(-1);
        return (
          turns.length > count &&
          latest?.getAttribute("data-message-status") !== "streaming" &&
          Boolean(latest?.textContent?.trim())
        );
      },
      baseline,
      { timeout: 120_000 },
    );
    expect(createdEarly, "request must wait for spoken confirmation").toBe(
      false,
    );
    await composer.fill("Yes, send that request.");
    await composer.press("Enter");
    const confirm = requesterChat.getByTestId("specialist-directive-confirm");
    await expect
      .poll(async () => createdEarly || (await confirm.isVisible()), {
        timeout: 120_000,
      })
      .toBe(true);
    if (!createdEarly && (await confirm.isVisible())) await confirm.click();
    const response = await created;
    expect(response.status(), "POST /api/one/information-requests (chat)").toBe(
      200,
    );
    const chatBundle = (await response.json()) as RequestBundle;
    expect(chatBundle.bundleId).toBeTruthy();
    expect(chatBundle.items.length).toBeGreaterThanOrEqual(1);
    const asked = chatBundle.items[0]!;
    expect(asked.status).toBe("pending");

    await expectCenterStatus(
      ownerPage,
      ownerIdentity!,
      "pending",
      asked.requestId,
      "pending",
    );

    // Withdraw with the same bearer the page just used so the fixture is
    // left as it was found.
    const authorization = response.request().headers()["authorization"] ?? "";
    expect(
      authorization.startsWith("Bearer "),
      "the chat ask carried a bearer",
    ).toBe(true);
    const cancelled = await requesterChat.request.post(
      `/api/one/information-requests/${encodeURIComponent(chatBundle.bundleId)}/cancel`,
      { headers: { Authorization: authorization } },
    );
    expect(
      cancelled.status(),
      "POST /api/one/information-requests/<bundle>/cancel",
    ).toBe(200);
    await expectCenterStatus(
      ownerPage,
      ownerIdentity!,
      "previous",
      asked.requestId,
      "cancelled",
    );
  });
});
