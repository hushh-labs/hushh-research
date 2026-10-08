import path from "node:path";
import { fileURLToPath } from "node:url";
import { commerceEvidence, CommerceRehearsalWait, CommerceRehearsalFailure, safeCommerceFailure, sameJson } from "./scope-commerce-rehearsal-contract.mjs";
import { commercePreflight } from "./scope-commerce-rehearsal-preflight.mjs";
import { loadCommerceState, newCommerceState, saveCommerceState, acquireCommerceStateLease } from "./scope-commerce-rehearsal-state.mjs";
import { openCommerceBrowsers, bindCommerceFixtures, assertCommerceSessions } from "./scope-commerce-rehearsal-browser.mjs";
import { runCommerceSequence } from "./scope-commerce-rehearsal-sequence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ARGUMENTS = new Map([
  ["--app-origin", "appOrigin"], ["--account-id", "accountId"], ["--state", "stateFile"],
  ["--fixtures-file", "fixturesFile"], ["--reviewer-binding-file", "reviewerBindingFile"],
  ["--isolation-evidence-file", "isolationEvidenceFile"], ["--operation-state-file", "operationStateFile"],
  ["--approve-action", "approveAction"],
]);

export function parseCommerceArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = ARGUMENTS.get(args[index]);
    commerceEvidence(key && args[index + 1] && !args[index + 1].startsWith("--") && options[key] === undefined,
      "EXPLICIT_REHEARSAL_ARGUMENTS_REQUIRED");
    options[key] = args[index + 1];
  }
  commerceEvidence([...ARGUMENTS.values()].filter(key => key !== "approveAction").every(key => options[key]), "EXPLICIT_REHEARSAL_ARGUMENTS_REQUIRED");
  commerceEvidence(!options.approveAction || /^[a-f0-9]{32}$/.test(options.approveAction), "EXACT_OPERATOR_ACTION_INVALID");
  return options;
}

function report(runtime, error = null) {
  return {
    passed: error === null, phase: runtime.phase,
    boundary: runtime.boundary || runtime.phase, scenario: runtime.scenario || null,
    ...(error ? { code: safeCommerceFailure(error), waiting: error instanceof CommerceRehearsalWait,
      nextCheckAt: error instanceof CommerceRehearsalWait ? error.nextCheckAt : null } : {}),
    ...(runtime.pendingAction ? { requiredAction: runtime.pendingAction } : {}),
    ...(runtime.externalStep ? { externalStep: runtime.externalStep } : {}),
    milestones: runtime.state?.records.map(record => ({ kind: record.kind, stage: record.stage,
      requestId: record.requestId || null, purchaseId: record.purchaseId || null, checks: record.checks })) || [],
    webEvidenceOnly: true, nativeAcceptance: "unverified_requires_real_OS_run",
    sameSessionProofScope: "protected_client_navigation_in_current_web_context",
    hostedProviderInteraction: "external_human_only", developerSandboxMilestones: "excluded",
    feesConserved: error === null && runtime.proof?.feesConserved === true,
    feeConservationScope: runtime.proof?.feeConservationScope === "funding_allocations_and_verified_successful_transfer_payout_receipts"
      ? "funding_allocations_and_verified_successful_transfer_payout_receipts" : "unverified",
    liveCostModelVerified: false,
  };
}

export async function verifyReviewerScopeCommerce(options) {
  const runtime = { options, phase: "strict-sandbox-preflight", state: null };
  try {
    const preflight = await commercePreflight(repoRoot, options);
    runtime.releaseState = await acquireCommerceStateLease(repoRoot, options.stateFile);
    runtime.proof = preflight.proof; runtime.identities = preflight.identities;
    runtime.state = await loadCommerceState(repoRoot, options.stateFile) || newCommerceState({
      appOrigin: options.appOrigin, platformAccountId: options.accountId, schemaHead: preflight.schemaHead, fixtures: preflight.fixtures,
    });
    commerceEvidence(runtime.state.appOrigin === options.appOrigin && runtime.state.platformAccountId === options.accountId &&
      runtime.state.schemaHead === preflight.schemaHead && sameJson(runtime.state.fixtures, preflight.fixtures), "CHECKPOINT_ENVIRONMENT_OR_FIXTURE_CHANGED");
    runtime.save = () => saveCommerceState(repoRoot, options.stateFile, runtime.state);
    runtime.phase = "authenticated-application-pin";
    Object.assign(runtime, await openCommerceBrowsers(repoRoot, options, preflight));
    runtime.phase = "canonical-fixture-and-recipient-binding";
    await bindCommerceFixtures(runtime.actors, runtime.identities, preflight.fixtures);
    if (!runtime.state.checks.includes("pairBound")) runtime.state.checks.push("pairBound");
    await runtime.save();
    await runCommerceSequence(runtime);
    assertCommerceSessions(runtime.actors);
    return report(runtime);
  } catch (error) {
    try { if (runtime.actors) assertCommerceSessions(runtime.actors); }
    catch { error = new CommerceRehearsalFailure("REHEARSAL_MUTATION_OR_CRITICAL_API_FAILED"); }
    return report(runtime, error);
  } finally { await runtime.browser?.close(); await runtime.releaseState?.(); }
}

const HELP = `Bounded consumer-paid sharing sandbox rehearsal (web evidence only).
Required: --app-origin HTTPS_ORIGIN --account-id acct_ID --state tmp/scope-commerce-rehearsal/RUN.json
  --fixtures-file PRIVATE_JSON --reviewer-binding-file PRIVATE_JSON
  --isolation-evidence-file PRIVATE_JSON --operation-state-file PRIVATE_JSON
Resume with the same arguments. --approve-action OPAQUE_ID authorizes exactly the reported quote,
negative owner costs, withdrawal or source refund; every new action requires its own approval.
Two canonical reviewer identities and initialized isolated synthetic scopes/recipient keys are required.
Fixtures contain primary/counterpart {synthetic:true,personRef,scopeRef,scopeHandle,machineScope,expectedPayloadSha256}.
Hosted Checkout/Connect remain external human Account UI steps; no Stripe URLs or secrets are output.
Prove $0.50 then $10 funding per reviewer; gross cap $20 each, platform capital $25 total.
Use real five-minute activation and one-hour terms. Pause new admission before manual maturity,
keep reconciliation running, complete manual withdrawal, then resume for weekly payout.
No native, developer sandbox or financial-conservation claim is inferred from browser flags or transfers.
Checkpoints contain only sanitized identifiers, timestamps and amounts; no traces/screenshots are collected.
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) process.stdout.write(HELP);
  else {
    let result;
    try { result = await verifyReviewerScopeCommerce(parseCommerceArguments(process.argv.slice(2))); }
    catch (error) { result = { passed: false, phase: "arguments", code: safeCommerceFailure(error) }; }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.passed ? 0 : result.waiting ? 2 : 1;
  }
}
