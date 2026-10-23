#!/usr/bin/env node
// Headless acceptance of the existing app flow; never derives a vault key.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { installPwmBrowserProof, hasIncrementalPwmStream, admitOwnerConfirmedPwmClaim, admitPwmStore } from "./pwm-browser-proof.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "https://uat.one.hussh.ai").replace(/\/$/, "");
const expectedEmails = String(process.env.PWM_EXPECTED_EMAILS || "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
const confirmedProfile = String(process.env.PWM_OWNER_CONFIRMED_PROFILE || "").trim();
const researchConfirmedProfile = process.env.PWM_RESEARCH_CONFIRMED_PROFILE === "true";
const pane = "/one?profile_pane=1&profile_panel=world-model";
const evidence = { schema: "pwm_uat_acceptance.v1", stages: {}, public_result: null, usage: null };
let phase = "preflight", session, cold, browser, reviewer, planId = null, storeAttempts = 0, baselineRevision = null;
let chosen = null, savedRevision = null, researchPosts = 0, key = null;
function check(condition, code) { if (!condition) throw new Error(code); }
function stage(name) { phase = name; process.stdout.write(`[pwm-acceptance] stage=${name}\n`); }
function privateOutput() {
  const output = path.resolve(process.env.PWM_PROOF_OUTPUT || path.join(repoRoot, "tmp/pwm-acceptance.json"));
  const relative = path.relative(path.join(repoRoot, "tmp"), output);
  check(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "private_output_required");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const realRelative = path.relative(fs.realpathSync(path.join(repoRoot, "tmp")), fs.realpathSync(path.dirname(output)));
  check(!realRelative.startsWith("..") && !path.isAbsolute(realRelative), "private_output_parent_refused");
  let payload = evidence;
  const encodedKey = process.env.PWM_EVIDENCE_PUBLIC_KEY;
  if (encodedKey) {
    const publicKey = createPublicKey({ key: Buffer.from(encodedKey, "base64"), format: "der", type: "spki" });
    const key = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(evidence)), cipher.final()]);
    payload = { schema: "pwm_sealed_evidence.v1", wrapped_key: publicEncrypt({ key: publicKey, oaepHash: "sha256" }, key).toString("base64"),
      iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    key.fill(0);
  }
  // CI may publish only a sealed envelope, never the owner's research response.
  check(!process.env.GITHUB_ACTIONS || encodedKey, "ci_evidence_key_required");
  const temporary = `${output}.${randomBytes(8).toString("hex")}.tmp`;
  check(!fs.existsSync(output) || !fs.lstatSync(output).isSymbolicLink(), "private_output_symlink_refused");
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, output);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function exportInBrowser(active, mode, input = null) {
  await reviewer.navigateInApp(active.page, "/one/pkm");
  await active.page.getByRole("tab", { name: "Sharing", exact: true }).click();
  check(await active.page.evaluate(({ mode, input }) => window.__PWM_ACCEPTANCE__.armExport(mode, input), { mode, input }), "export_admission_refused");
  await active.page.getByTestId("memory-export-button").click();
  await active.page.waitForFunction(() => !["pending", "idle"].includes(window.__PWM_ACCEPTANCE__.exportStatus()), null, { timeout: 60_000 });
  return active.page.evaluate(() => window.__PWM_ACCEPTANCE__.exportStatus());
}
async function snapshot(active) {
  const token = await active.capture.ownerToken();
  const value = await reviewer.fetchOwnerJson(`/api/pkm/domain-snapshot/${encodeURIComponent(reviewer.reviewerUid)}/one_memory`, token);
  check(value?.schema_version === "pkm_domain_snapshot.v1" && value.user_id === reviewer.reviewerUid && value.domain === "one_memory" && Number.isSafeInteger(value.content_revision), "snapshot_contract_failed");
  return value.content_revision;
}

/** Supply a real, operator-issued Firebase credential to this local test only. */
export async function installPwmOwnerLogin(page, ownerLogin, origin) {
  await page.route(`${origin}/api/app-config/review-mode/session`, async route => {
    try {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== "POST" || url.origin !== origin ||
        url.pathname !== "/api/app-config/review-mode/session" || url.search) throw new Error();
      const body = request.postDataJSON();
      if (body.subject !== "reviewer" || body.reviewer_uid !== ownerLogin.userId ||
        body.smoke_passphrase !== ownerLogin.passphrase ||
        !Object.keys(body).every(key => ["subject", "reviewer_uid", "smoke_passphrase"].includes(key))) throw new Error();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: ownerLogin.token }) });
    } catch { await route.abort("blockedbyclient"); }
  });
}

/** Exact research mutations admitted during the explicit research action/wait. */
export function admitPwmResearch(request, { phase, appOrigin: origin, researchPosts: count, emailPreference, publicProfile = null, researchProvider = "azure_openai_web_search" }) {
  try {
    const url = new URL(request.url()), method = request.method();
    if (!["research", "research_action", "research_wait"].includes(phase) || url.origin !== origin) return false;
    const body = request.postData() ? request.postDataJSON() : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    if (method === "POST" && ["/api/one/world-model/ensure", "/api/one/world-model/jobs"].includes(url.pathname) && count < 20) {
      const profiles = body.public_profiles;
      if (publicProfile && url.pathname.endsWith("/jobs") && profiles === undefined) return false;
      if (profiles !== undefined && (!publicProfile || !url.pathname.endsWith("/jobs") ||
          !profiles || Object.keys(profiles).length !== 2 || profiles.permitted_public_sources !== true ||
          !Array.isArray(profiles.urls) || profiles.urls.length !== 1 || profiles.urls[0] !== publicProfile)) return false;
      return Object.keys(body).every(key => ["owner_decisions", "refresh", "public_profiles"].includes(key)) &&
        (url.pathname.endsWith("/jobs") ? body.refresh === true : !("refresh" in body));
    }
    return method === "PUT" && url.pathname === "/api/one/world-model/preferences" &&
      body.enabled === true && body.email_enabled === emailPreference && typeof body.consent_version === "string" && body.consent_version === ({ azure_openai_web_search: "pwm-azure-bing-v1", azure_openai_tavily: "pwm-azure-tavily-v1" })[researchProvider] &&
      Object.keys(body).every(key => ["enabled", "email_enabled", "consent_version"].includes(key));
  } catch { return false; }
}

if (process.argv.includes("--help")) {
  process.stdout.write("Authorized UAT PWM research, one reviewed save, browser-only preservation and cold readback. Requires PWM_EXPECTED_EMAILS, PWM_OWNER_CONFIRMED_PROFILE (human-confirmed GitHub profile) and REVIEWER_ALLOW_SHARED_MUTATIONS=true. CI evidence requires PWM_EVIDENCE_PUBLIC_KEY (base64 DER SPKI).\n");
  process.exit(0);
}
export async function runPwmAcceptance({ ownerLogin = null } = {}) {
try {
  check(appOrigin === "https://uat.one.hussh.ai", "uat_only");
  check(expectedEmails.length > 0 && confirmedProfile && process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true", "explicit_owner_and_mutation_required");
  check(!process.env.GITHUB_ACTIONS || process.env.PWM_EVIDENCE_PUBLIC_KEY, "ci_evidence_key_required");
  if (ownerLogin) {
    // Operator-only credentials for the human-authorized existing owner.
    // Firebase still verifies the signed token; vault unwrap still requires
    // that owner's passphrase. Never alter the deployed reviewer fixture.
    check(!process.env.GITHUB_ACTIONS && expectedEmails.includes(ownerLogin.email) &&
      ["userId", "passphrase", "token"].every(key => typeof ownerLogin[key] === "string" && ownerLogin[key]), "owner_login_capsule_refused");
    process.env.REVIEWER_UID = ownerLogin.userId;
    process.env.REVIEWER_VAULT_PASSPHRASE = ownerLogin.passphrase;
    evidence.authentication_basis = "operator_authorized_existing_owner";
  } else evidence.authentication_basis = "configured_reviewer";
  await prepareReviewerRehearsal({ repoRoot, appOrigin });
  reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs: 360_000,
    explicitLoginOnly: true,
    configurePage: async page => {
      if (ownerLogin) await installPwmOwnerLogin(page, ownerLogin, appOrigin);
      await page.addInitScript(installPwmBrowserProof, { expectedUserId: reviewer.reviewerUid, expectedEmails });
    },
    admitMutation: async request => {
      const url = new URL(request.url()), method = request.method();
      if (url.origin !== appOrigin) return false;
      if (phase === "sign_out" && method === "DELETE") {
        if (url.pathname === "/api/auth/session") return !request.postData();
        if (url.pathname === "/api/notifications/unregister") {
          const body = request.postDataJSON();
          return body.user_id === reviewer.reviewerUid && (body.platform === undefined || body.platform === "web") &&
            typeof body.device_id === "string" && body.device_id.length > 0 &&
            Object.keys(body).every(key => ["user_id", "platform", "device_id"].includes(key));
        }
      }
      if (admitPwmResearch(request, { phase, appOrigin, researchPosts, emailPreference: evidence.email_preference, researchProvider: evidence.research_provider, publicProfile: researchConfirmedProfile ? confirmedProfile : null })) {
        if (method === "POST") researchPosts++;
        return true;
      }
      if (phase !== "save" || method !== "POST" || url.pathname !== "/api/pkm/store-domain" || storeAttempts >= 2) return false;
      const body = request.postDataJSON();
      if (!admitPwmStore(body, { owner: reviewer.reviewerUid, baselineRevision, planId })) return false;
      planId = body.mutation_plan.plan_id; storeAttempts++; return true;
    },
  });
  browser = await reviewer.chromium.launch({ headless: true });
  stage("visible_vault_challenge");
  await reviewer.assertVisibleVaultChallenge(browser, "/one/pkm");
  evidence.stages.visible_vault_challenge = true;
  stage("unlock_and_owner");
  session = await reviewer.openSession(browser, "/one/pkm");
  await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__?.identityProof().parse_ok, null, { timeout: 20_000 }).catch(() => undefined);
  evidence.owner_verification = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.identityProof());
  for (const [field, code] of [["lookup_seen", "owner_lookup_missing"], ["http_ok", "owner_lookup_http_failed"],
    ["parse_ok", "owner_lookup_invalid"], ["uid_match", "owner_uid_mismatch"], ["email_verified", "owner_email_unverified"],
    ["expected_email_match", "owner_email_mismatch"], ["current_bridge", "owner_bridge_changed"], ["observer_installed", "owner_observer_changed"]]) {
    check(evidence.owner_verification[field], code);
  }
  const commitment = reviewer.vaultKeyCommitment(await session.capture.vaultState());
  evidence.stages.intended_owner = true;
  baselineRevision = await snapshot(session);
  check(await exportInBrowser(session, "baseline") === "baseline_ready", "baseline_export_failed");
  evidence.stages.baseline = true;

  stage("research");
  const started = Date.now();
  evidence.research_before = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.researchState());
  check(await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.beginResearch()), "research_observer_refused");
  await reviewer.navigateInApp(session.page, pane);
  await session.page.locator('[data-voice-control-id="pwm_settings_open"]').click();
  const researchSwitch = session.page.getByRole("switch", { name: "Research public pages", exact: true });
  await researchSwitch.waitFor();
  evidence.email_preference = (await session.page.getByRole("switch", { name: "Email me when it’s ready", exact: true }).getAttribute("aria-checked")) === "true";
  evidence.research_ui = { enabled_before: (await researchSwitch.getAttribute("aria-checked")) === "true" };
  await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__.preferences()?.research_provider, null, { timeout: 20_000 });
  evidence.research_provider = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.preferences().research_provider);
  check(["azure_openai_web_search", "azure_openai_tavily"].includes(evidence.research_provider), "research_provider_unsupported");
  stage("research_action");
  check(!researchConfirmedProfile || evidence.research_ui.enabled_before, "profile_research_needs_existing_consent");
  if ((await researchSwitch.getAttribute("aria-checked")) !== "true") {
    evidence.research_ui.action = "enable";
    await researchSwitch.click();
    // Enabling is an explicit retry: follow that ensure job rather than
    // racing its pending response with a second Check for updates action.
    await session.page.getByRole("dialog", { name: "Research and email", exact: true })
      .getByRole("button", { name: "Close detail panel", exact: true }).click();
  } else if (researchConfirmedProfile) {
    evidence.research_ui.action = "research_owner_confirmed_public_profile";
    evidence.research_inputs = { identity_source: "authenticated_owner", public_profiles: [confirmedProfile],
      basis: "explicit_human_profile_ownership_confirmation" };
    await session.page.getByRole("dialog", { name: "Research and email", exact: true })
      .getByRole("button", { name: "Close detail panel", exact: true }).click();
    await session.page.locator('[data-voice-control-id="pwm_public_sources_open"]').click();
    const sources = session.page.getByRole("dialog", { name: "Add a public source", exact: true });
    await sources.getByLabel("Page links, one per line", { exact: true }).fill(confirmedProfile);
    await sources.getByRole("checkbox").check();
    await sources.locator('[data-voice-control-id="pwm_public_profiles_research"]').click();
  } else {
    const refresh = session.page.locator('[data-voice-control-id="pwm_refresh"]');
    if (await refresh.isVisible()) {
      evidence.research_ui.action = "refresh";
      await refresh.click();
    } else {
      evidence.research_ui.action = "retry_existing_state";
      evidence.research_state = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.researchState());
      check(!evidence.research_before.exhausted && !evidence.research_state.exhausted, "research_exhausted");
      await session.page.getByRole("dialog", { name: "Research and email", exact: true })
        .getByRole("button", { name: "Close detail panel", exact: true }).click();
      // Respect the authored stall/cooldown. Never toggle consent or POST
      // around the app to manufacture a refresh of a pending checkpoint.
      const retry = session.page.locator('[data-voice-control-id="pwm_retry"]');
      await retry.waitFor({ state: "visible", timeout: 360_000 }).catch(() => undefined);
      check(await retry.isVisible(), "research_retry_unavailable");
      await retry.click({ timeout: 360_000 });
    }
  }
  await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__.researchPosts() > 0, null, { timeout: 20_000 }).catch(() => undefined);
  check(await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.researchPosts() > 0), "research_start_not_requested");
  stage("research_wait");
  await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__.researchState().fresh_acknowledged ||
    window.__PWM_ACCEPTANCE__.researchSettled(), null, { timeout: 60_000 });
  const acknowledged = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.researchState());
  if (!acknowledged.fresh_acknowledged && acknowledged.status === "saved" &&
      evidence.research_ui.action === "retry_existing_state") {
    // Ensure may resolve an aged-out checkpoint as recently prepared. Only
    // the app's newly available explicit refresh may start another paid run.
    await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__.preferences()?.research_provider, null, { timeout: 20_000 });
  evidence.research_provider = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.preferences().research_provider);
  check(["azure_openai_web_search", "azure_openai_tavily"].includes(evidence.research_provider), "research_provider_unsupported");
  stage("research_action");
    await session.page.locator('[data-voice-control-id="pwm_settings_open"]').click();
    const refresh = session.page.locator('[data-voice-control-id="pwm_refresh"]');
    await refresh.waitFor({ state: "visible", timeout: 20_000 });
    evidence.research_ui.follow_up = "refresh_after_recently_prepared";
    const previousPosts = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.researchPosts());
    await refresh.click();
    stage("research_wait");
    await session.page.waitForFunction(previous => window.__PWM_ACCEPTANCE__.researchPosts() > previous,
      previousPosts, { timeout: 20_000 });
    await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__.researchState().fresh_acknowledged ||
      window.__PWM_ACCEPTANCE__.researchSettled(), null, { timeout: 60_000 });
  }
  check(await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.researchState().fresh_acknowledged), "research_cache_reused");
  await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__.researchSettled(), null, { timeout: 900_000 });
  evidence.research_state = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.researchState());
  check(evidence.research_state.fresh_acknowledged, "research_start_not_acknowledged");
  check(await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.publicResult()?.status === "offered"), "research_ended_without_offered_result");
  evidence.wall_time_ms = Date.now() - started;
  evidence.public_result = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.publicResult());
  evidence.streams = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.streamProof());
  // Read-only jobs lookup returns the completed job's usage header.
  check(await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.refreshUsage()), "usage_header_missing");
  evidence.usage = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.usage());
  check(evidence.usage?.model_calls > 0 && evidence.usage.recorded_calls === evidence.usage.model_calls &&
    ["input_tokens", "output_tokens", "cached_input_tokens", "provider_elapsed_ms", "bing_requests"].every(key =>
      typeof evidence.usage[key] === "number" && Number.isFinite(evidence.usage[key]) && evidence.usage[key] >= 0), "complete_usage_required");
  check(hasIncrementalPwmStream(evidence.streams), "incremental_stream_not_proven");
  evidence.stages.incremental_stream = true;
  const offered = evidence.public_result;
  check(offered.pkm_written === false && offered.research.provider === "azure_openai_web_search" &&
    offered.research.source_use === "azure_web_grounded_display_only" &&
    offered.grounded_answers.length > 0 && offered.grounded_answers.every(answer => answer.citations?.length > 0), "azure_citations_missing");
  evidence.stages.azure_citations = true;
  await session.page.getByTestId("pwm-fact-row").first().waitFor();
  evidence.stages.visible_results = true;
  // Azure deliberately retains candidate_for_review. The human's separate
  // ownership confirmation authorizes reviewing this exact profile only.
  evidence.review_basis = { kind: "owner_confirmed_public_profile", url: confirmedProfile,
    model_identity: offered.research.identity.state, model_match_status: offered.report.match_status };
  // Model assesses meaning. Independently require a reachable primary source;
  // report this as availability evidence, never as an independent semantic judge.
  for (const section of offered.report.sections) {
    for (const fact of section.facts) {
      if (!admitOwnerConfirmedPwmClaim(offered, fact, confirmedProfile)) continue;
      for (const source of fact.sources) {
        const url = new URL(source.url);
        const confirmation = new URL(confirmedProfile);
        if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port ||
            url.pathname.replace(/\/$/, "").toLowerCase() !== confirmation.pathname.replace(/\/$/, "").toLowerCase()) continue;
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
        if (response.ok) {
          const claim = { statement: fact.statement, topic: section.kind, source: source.url };
          const candidateKey = await session.page.evaluate(({ statement, topic }) => window.__PWM_ACCEPTANCE__.bindClaim(statement, topic), claim);
          if (candidateKey) { chosen = claim; key = candidateKey; break; }
        }
      }
      if (chosen) break;
    }
    if (chosen) break;
  }
  check(chosen && key, "fresh_supported_primary_claim_required");
  evidence.selected_public_claim = chosen;
  check(await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.identityMatches()), "owner_changed");
  stage("save");
  const [receipt] = await Promise.all([
    session.page.waitForResponse(response => new URL(response.url()).origin === appOrigin &&
      new URL(response.url()).pathname === "/api/pkm/store-domain" && response.request().method() === "POST", { timeout: 120_000 }),
    session.page.locator(`button[data-pwm-fact-yes="${key}"]`).click(),
  ]);
  const body = await receipt.json();
  check(receipt.status() === 200 && body.success === true && body.conflict !== true && Number.isSafeInteger(body.data_version) && body.data_version > baselineRevision, "new_save_receipt_required");
  savedRevision = body.data_version;
  evidence.saved_revision = savedRevision; evidence.baseline_revision = baselineRevision;
  evidence.stages.encrypted_store = true;
  check(await snapshot(session) === savedRevision, "fresh_snapshot_revision_mismatch");
  stage("preservation");
  check(await exportInBrowser(session, "after") === "preserved", "one_memory_preservation_failed");
  const decidedAt = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.decisionTime());
  const preservation = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.preservationCommitment());
  evidence.stages.exact_preservation = true;
  await reviewer.navigateInApp(session.page, pane);
  const savedRow = session.page.getByTestId("pwm-fact-row").filter({ hasText: chosen.statement });
  await savedRow.getByText("Confirmed by you", { exact: true }).waitFor();
  check(await savedRow.locator('[data-pwm-fact-yes]').count() === 0, "saved_row_still_draft");
  session.readOnlyGuard.assertNoBlockedMutation(); session.capture.assertNoCriticalApiFailures("PWM save");
  evidence.stages.same_session_saved = true;
  stage("sign_out");
  await reviewer.navigateInApp(session.page, "/one?profile_pane=1&profile_panel=security&profile_detail=session");
  await session.page.evaluate(() => { window.__PWM_SIGN_OUT_DOCUMENT__ = true; });
  const [logoutReceipt] = await Promise.all([
    session.page.waitForResponse(response => new URL(response.url()).origin === appOrigin &&
      new URL(response.url()).pathname === "/api/auth/session" && response.request().method() === "DELETE"),
    session.page.locator('button[data-voice-label="Sign out"]').click(),
  ]);
  check(logoutReceipt.ok(), "sign_out_session_delete_failed");
  await session.page.waitForURL(`${appOrigin}/`);
  await session.page.locator('[data-testid="native-route-home"][data-native-auth-state="anonymous"][data-native-data-state="loaded"]').waitFor({ state: "attached" });
  check(await session.page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    return !window.__PWM_SIGN_OUT_DOCUMENT__ && window.__HUSHH_NATIVE_TEST__?.autoReviewerLogin === false &&
      !window.__HUSHH_NATIVE_TEST__?.vaultPassphrase && !window.__HUSHH_NATIVE_TEST__?.reviewerSessionPassphrase &&
      response.status === 401 && (await response.json()).authenticated === false;
  }), "sign_out_anonymous_required");
  session.readOnlyGuard.assertNoBlockedMutation();
  evidence.stages.signed_out = true;
  await session.context.close(); session = null;
  stage("cold_readback");
  cold = await reviewer.openSession(browser, "/one/pkm");
  await cold.page.waitForFunction(() => window.__PWM_ACCEPTANCE__?.identityMatches(), null, { timeout: 20_000 });
  check(reviewer.vaultKeyCommitment(await cold.capture.vaultState()) === commitment, "vault_key_changed");
  check(await cold.page.evaluate(() => window.__PWM_ACCEPTANCE__.identityMatches()), "cold_owner_changed");
  evidence.stages.signed_in_again = true;
  check(await snapshot(cold) === savedRevision, "cold_revision_mismatch");
  check(await exportInBrowser(cold, "cold", { ...chosen, key, decided_at: decidedAt, preservation }) === "cold_verified", "cold_claim_missing");
  await reviewer.navigateInApp(cold.page, pane);
  await cold.page.getByTestId("pwm-fact-row").filter({ hasText: chosen.statement }).getByText("Confirmed by you", { exact: true }).waitFor();
  cold.readOnlyGuard.assertNoBlockedMutation(); cold.capture.assertNoCriticalApiFailures("cold readback");
  evidence.stages.cold_saved = true; evidence.status = "passed";
} catch (error) {
  evidence.status = "failed"; evidence.failed_stage = phase;
  // Playwright errors may include locators/owner details. Persist only our fixed codes.
  evidence.failure_code = /^[a-z_]+$/.test(error.message) ? error.message : "runtime_assertion_failed";
  if (session) {
    evidence.research_state = await session.page.evaluate(() => window.__PWM_ACCEPTANCE__?.researchState()).catch(() => null);
    evidence.public_result ??= await session.page.evaluate(() => window.__PWM_ACCEPTANCE__?.publicResult()).catch(() => null);
    evidence.streams ??= await session.page.evaluate(() => window.__PWM_ACCEPTANCE__?.streamProof()).catch(() => []);
  }
  process.exitCode = 1;
} finally {
  await session?.context.close().catch(() => undefined);
  await cold?.context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  privateOutput();
  process.stdout.write(`[pwm-acceptance] ${evidence.status} stage=${phase} code=${evidence.failure_code ?? "verified"}\n`);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runPwmAcceptance();
