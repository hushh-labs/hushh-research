#!/usr/bin/env node
// Headless acceptance of the existing app flow; never derives a vault key.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { installPwmBrowserProof, hasIncrementalPwmStream, admitOwnerConfirmedPwmClaim, admitPwmStore } from "./pwm-browser-proof.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "https://uat.one.hussh.ai").replace(/\/$/, "");
const expectedEmails = String(process.env.PWM_EXPECTED_EMAILS || "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
const confirmedProfile = String(process.env.PWM_OWNER_CONFIRMED_PROFILE || "").trim();
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

if (process.argv.includes("--help")) {
  process.stdout.write("Authorized UAT PWM research, one reviewed save, browser-only preservation and cold readback. Requires PWM_EXPECTED_EMAILS, PWM_OWNER_CONFIRMED_PROFILE (human-confirmed GitHub profile) and REVIEWER_ALLOW_SHARED_MUTATIONS=true. CI evidence requires PWM_EVIDENCE_PUBLIC_KEY (base64 DER SPKI).\n");
  process.exit(0);
}
try {
  check(appOrigin === "https://uat.one.hussh.ai", "uat_only");
  check(expectedEmails.length > 0 && confirmedProfile && process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true", "explicit_owner_and_mutation_required");
  check(!process.env.GITHUB_ACTIONS || process.env.PWM_EVIDENCE_PUBLIC_KEY, "ci_evidence_key_required");
  await prepareReviewerRehearsal({ repoRoot, appOrigin });
  reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs: 360_000,
    configurePage: async page => page.addInitScript(installPwmBrowserProof, { expectedUserId: reviewer.reviewerUid, expectedEmails }),
    admitMutation: async request => {
      const url = new URL(request.url()), method = request.method();
      if (url.origin !== appOrigin) return false;
      if (phase === "research" && method === "POST" && ["/api/one/world-model/ensure", "/api/one/world-model/jobs"].includes(url.pathname) && researchPosts < 20) {
        const body = request.postData() ? request.postDataJSON() : {};
        if (!Object.keys(body).every(key => ["owner_decisions", "refresh"].includes(key)) ||
            (url.pathname.endsWith("/jobs") ? body.refresh !== true : "refresh" in body)) return false;
        researchPosts++; return true;
      }
      if (phase === "research" && method === "PUT" && url.pathname === "/api/one/world-model/preferences") {
        const body = request.postDataJSON();
        return body.enabled === true && body.email_enabled === evidence.email_preference && body.consent_version === "pwm-azure-bing-v1" &&
          Object.keys(body).every(key => ["enabled", "email_enabled", "consent_version"].includes(key));
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
  await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__?.identityMatches(), null, { timeout: 20_000 });
  const commitment = reviewer.vaultKeyCommitment(await session.capture.vaultState());
  evidence.stages.intended_owner = true;
  baselineRevision = await snapshot(session);
  check(await exportInBrowser(session, "baseline") === "baseline_ready", "baseline_export_failed");
  evidence.stages.baseline = true;

  stage("research");
  const started = Date.now();
  check(await session.page.evaluate(() => window.__PWM_ACCEPTANCE__.beginResearch()), "research_observer_refused");
  await reviewer.navigateInApp(session.page, pane);
  await session.page.locator('[data-voice-control-id="pwm_settings_open"]').click();
  const researchSwitch = session.page.getByRole("switch", { name: "Research public pages", exact: true });
  await researchSwitch.waitFor();
  evidence.email_preference = (await session.page.getByRole("switch", { name: "Email me when it’s ready", exact: true }).getAttribute("aria-checked")) === "true";
  if ((await researchSwitch.getAttribute("aria-checked")) !== "true") {
    await researchSwitch.click();
    // Enabling is an explicit retry: follow that ensure job rather than
    // racing its pending response with a second Check for updates action.
    await session.page.getByRole("dialog", { name: "Research and email", exact: true })
      .getByRole("button", { name: "Close detail panel", exact: true }).click();
  } else {
    await session.page.locator('[data-voice-control-id="pwm_refresh"]').click();
  }
  await session.page.waitForFunction(() => window.__PWM_ACCEPTANCE__.researchPosts() > 0 && window.__PWM_ACCEPTANCE__.publicResult()?.status === "offered", null, { timeout: 900_000 });
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
  const receiptPromise = session.page.waitForResponse(response => new URL(response.url()).pathname === "/api/pkm/store-domain" && response.request().method() === "POST", { timeout: 120_000 });
  await session.page.locator(`button[data-pwm-fact-yes="${key}"]`).click();
  const receipt = await receiptPromise, body = await receipt.json();
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
  await session.context.close(); session = null;
  stage("cold_readback");
  cold = await reviewer.openSession(browser, "/one/pkm");
  await cold.page.waitForFunction(() => window.__PWM_ACCEPTANCE__?.identityMatches(), null, { timeout: 20_000 });
  check(reviewer.vaultKeyCommitment(await cold.capture.vaultState()) === commitment, "vault_key_changed");
  check(await cold.page.evaluate(() => window.__PWM_ACCEPTANCE__.identityMatches()), "cold_owner_changed");
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
