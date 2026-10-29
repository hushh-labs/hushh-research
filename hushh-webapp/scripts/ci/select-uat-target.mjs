#!/usr/bin/env node
/**
 * Choose the commit UAT should move to, and prove it is allowed to move there.
 *
 * Replaces `git rev-parse origin/main` as the answer to "what do we deploy?".
 * A branch tip is whatever happened most recently, which is not the same
 * question as what is proven — and on 2026-08-14 those two answers differed:
 * a green merge was followed seconds later by a teammate's merge whose own
 * post-merge gate had not finished, and the tip was dispatched.
 *
 * Sources of truth, deliberately independent of each other:
 *   - what UAT runs now  -> the GitHub Deployment record for environment `uat`
 *   - whether a commit is proven -> that commit's OWN post-merge check run
 *   - what is on main    -> `git rev-list` against the fetched remote ref
 *
 * The decision logic lives in `uat-target-selection.mjs` so it can be tested
 * without a network. This file only gathers state and reports.
 *
 * Usage:
 *   node hushh-webapp/scripts/ci/select-uat-target.mjs [--limit 20] [--github-output] [--allow-no-op]
 *
 * Requires GITHUB_TOKEN and GITHUB_REPOSITORY (both present in Actions).
 * Exits non-zero when there is nothing safe to deploy, so a caller that
 * wants a target can fail closed.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { assertDeployable, reconcileUatTarget } from "./uat-target-selection.mjs";
import { createUatReleaseReaders } from "./uat-release-receipts.mjs";

const GATE_NAME = "Main Post-Merge Smoke";
const GATE_CHECK_NAME = `${GATE_NAME} Gate`;
const REPO = process.env.GITHUB_REPOSITORY || "hushh-labs/hushh-research";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const CHAT_ONLY_WORKFLOW = ".github/workflows/deploy-uat-one-chat.yml";
const FULL_UAT_WORKFLOW = ".github/workflows/deploy-uat.yml";
const ROLLBACK_WORKFLOW = ".github/workflows/rollback.yml";
const args = process.argv.slice(2);
const limit = Number(valueOf("--limit") || 20);
const writeGithubOutput = args.includes("--github-output");
// Selection-only callers can finish without starting a deployment. Other
// callers still require an actual deployable target and fail closed.
const allowNoOp = args.includes("--allow-no-op");

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

// Older native jobs created environment records just to read UAT secrets.
// They never move the hosted services. Unknown mutation/rehearsal records
// retain the existing fail-closed baseline behavior.
const NATIVE_WORKFLOWS = new Set([
  ".github/workflows/ship-ios-testflight.yml",
  ".github/workflows/resume-ios-testflight.yml",
  ".github/workflows/ios-voice-device.yml",
  ".github/workflows/ship-android-playstore-v1.yml",
]);
const READ_ONLY_UAT_WORKFLOWS = new Set([
  ".github/workflows/verify-protected-lists.yml",
  ".github/workflows/diagnose-uat-managed-vertex.yml",
]);
const KNOWN_UAT_WORKFLOWS = new Set([
  FULL_UAT_WORKFLOW,
  CHAT_ONLY_WORKFLOW,
  ROLLBACK_WORKFLOW,
  ...NATIVE_WORKFLOWS,
  ...READ_ONLY_UAT_WORKFLOWS,
]);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function api(path) {
  if (!TOKEN) throw new Error("GITHUB_TOKEN is required to read check runs.");
  // The fetch ban targets app code ("native platforms have no Next.js
  // server"). This file is a Node CI script on a GitHub runner: there is no
  // ApiService to route through and no browser to break.
  // eslint-disable-next-line no-restricted-syntax
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} -> ${response.status}`);
  }
  return response.json();
}

const { oneChatReleaseReceipt, fullUatReleaseAcceptance } = createUatReleaseReaders({
  repository: REPO,
  token: TOKEN,
  api,
  git,
  isAncestor,
});

/** That commit's own gate — never a branch status, never a PR check. */
async function gateFor(sha) {
  // Ask GitHub for the gate by name. The unfiltered list is newest first and
  // never de-duplicated across workflow runs, so on an idle main head the
  // hourly capacity clock's checks fill its first page and hide the gate.
  const payload = await api(
    `/commits/${sha}/check-runs?check_name=${encodeURIComponent(GATE_CHECK_NAME)}&per_page=100`,
  );
  const runs = (payload.check_runs || []).filter((run) => run.name === GATE_CHECK_NAME);
  if (!runs.length) return "absent";
  if (runs.some((r) => r.status === "completed" && r.conclusion === "success")) {
    return "success";
  }
  if (runs.some((r) => r.status !== "completed")) return "pending";
  if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out")) {
    return "failure";
  }
  return "unknown";
}

function workflowFile(run) {
  // The Actions API includes a ref suffix, for example workflow.yml@main.
  return String(run?.path || "").split("@", 1)[0];
}

function deploymentRunId(statusUrl) {
  try {
    const url = new URL(statusUrl);
    const prefix = `/${REPO}/actions/runs/`;
    if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix)) return null;
    return url.pathname.slice(prefix.length).match(/^([1-9]\d*)(?:\/job\/[1-9]\d*)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function workflowRunForDeployment(runId, deployment) {
  const latest = await api(`/actions/runs/${runId}`);
  const latestAttempt = Number(latest.run_attempt);
  if (!Number.isSafeInteger(latestAttempt) || latestAttempt < 1 || latestAttempt > 20)
    throw new Error(`UAT workflow ${runId} has an unsupported attempt history.`);
  if (latestAttempt === 1) return latest;
  const createdAt = Date.parse(String(deployment.created_at || ""));
  if (!Number.isFinite(createdAt))
    throw new Error(`UAT deployment ${deployment.id} cannot be matched to a workflow attempt.`);
  for (let attempt = latestAttempt; attempt >= 1; attempt -= 1) {
    const run = attempt === latestAttempt
      ? latest
      : await api(`/actions/runs/${runId}/attempts/${attempt}`);
    if (run.run_attempt !== attempt)
      throw new Error(`UAT workflow ${runId} attempt ${attempt} identity is inconsistent.`);
    const startedAt = Date.parse(String(run.run_started_at || ""));
    if (Number.isFinite(startedAt) && createdAt >= startedAt) return run;
  }
  throw new Error(`UAT deployment ${deployment.id} is outside its workflow attempt history.`);
}

function isCurrentPendingMutation(runId, run, status, deployment, workflow) {
  const currentRunId = process.env.GITHUB_RUN_ID || "";
  const currentAttempt = Number(process.env.GITHUB_RUN_ATTEMPT || "0");
  const runStart = Date.parse(String(run.run_started_at || ""));
  const deploymentStart = Date.parse(String(deployment.created_at || ""));
  return String(runId) === String(currentRunId) &&
    Number(run.run_attempt) === currentAttempt && currentAttempt > 0 &&
    run.status === "in_progress" &&
    (status?.state === "pending" || status?.state === "in_progress") &&
    Number.isFinite(runStart) && Number.isFinite(deploymentStart) && deploymentStart >= runStart &&
    [FULL_UAT_WORKFLOW, CHAT_ONLY_WORKFLOW].includes(workflow);
}

async function uatActualSha() {
  let sawNewerPartialMutation = false;
  let latestBackendSha = null;
  let latestBackendMutationId = null;
  for (let page = 1; page <= 10; page += 1) {
    const deployments = await api(`/deployments?environment=uat&per_page=100&page=${page}`);
    for (const deployment of deployments) {
      const statuses = await api(`/deployments/${deployment.id}/statuses?per_page=10`);
      const status = statuses[0];
      const runId = deploymentRunId(status?.log_url);
      if (!runId) throw new Error(`UAT deployment ${deployment.id} has no attributable workflow status.`);
      const run = await workflowRunForDeployment(runId, deployment);
      const workflow = workflowFile(run);
      if (!KNOWN_UAT_WORKFLOWS.has(workflow))
        throw new Error(`UAT deployment ${deployment.id} belongs to an unclassified workflow.`);
      if (NATIVE_WORKFLOWS.has(workflow) || READ_ONLY_UAT_WORKFLOWS.has(workflow)) continue;
      if (isCurrentPendingMutation(runId, run, status, deployment, workflow)) continue;
      if (workflow === CHAT_ONLY_WORKFLOW) {
        if (status?.state !== "success")
          throw new Error(`The latest UAT One chat mutation (${deployment.id}) is not healthy.`);
        const receipt = await oneChatReleaseReceipt(runId, run.run_attempt, run);
        if (latestBackendSha === null) {
          latestBackendSha = receipt.target_sha;
          latestBackendMutationId = deployment.id;
        }
        sawNewerPartialMutation = true;
        continue;
      }
      // A successful rollback changes serving traffic without producing a full
      // release receipt. Until it is reconciled, source ancestry is unknown.
      if (workflow === ROLLBACK_WORKFLOW)
        throw new Error(`The latest UAT mutation (${deployment.id}) is a rollback and needs reconciliation.`);
      if (workflow !== FULL_UAT_WORKFLOW) continue;
      if (status?.state !== "success")
        throw new Error(`The latest full UAT deployment (${deployment.id}) is not healthy.`);
      const receipt = await fullUatReleaseAcceptance(runId, run.run_attempt, run);
      return {
        sha: receipt.targetSha,
        serviceHeads: {
          backend: latestBackendSha ?? receipt.serviceHeads.backend,
          frontend: receipt.serviceHeads.frontend,
        },
        verified: !sawNewerPartialMutation,
        runUrl: `https://github.com/${REPO}/actions/runs/${runId}`,
        latestMutationId: deployment.id,
        latestBackendMutationId,
      };
    }
    if (deployments.length < 100) break;
    if (page === 10) throw new Error("UAT deployment history exceeds the verified 1,000-record window.");
  }
  throw new Error("No verified full UAT predecessor exists.");
}

async function uatMutationBaseline(servingState) {
  const mutations = [];
  const currentAttemptRecords = [];
  let hasExactBackendSource = false;
  let backendSupersededByHealthyMutation = false;
  for (let page = 1; page <= 10; page += 1) {
    const deployments = await api(`/deployments?environment=uat&per_page=100&page=${page}`);
    for (const deployment of deployments) {
      const statuses = await api(`/deployments/${deployment.id}/statuses?per_page=10`);
      const status = statuses[0];
      const runId = deploymentRunId(status?.log_url);
      if (!runId) throw new Error(`UAT deployment ${deployment.id} has no attributable workflow status.`);
      const run = await workflowRunForDeployment(runId, deployment);
      const workflow = workflowFile(run);
      if (!KNOWN_UAT_WORKFLOWS.has(workflow))
        throw new Error(`UAT deployment ${deployment.id} belongs to an unclassified workflow.`);
      if (NATIVE_WORKFLOWS.has(workflow) || READ_ONLY_UAT_WORKFLOWS.has(workflow)) continue;
      if (![FULL_UAT_WORKFLOW, CHAT_ONLY_WORKFLOW, ROLLBACK_WORKFLOW].includes(workflow))
        throw new Error(`UAT deployment ${deployment.id} is not a recognized service mutation.`);

      if (isCurrentPendingMutation(runId, run, status, deployment, workflow)) {
        currentAttemptRecords.push(deployment.id);
        continue;
      }
      const mutation = {
        deploymentId: deployment.id,
        deploymentSha: deployment.sha ?? null,
        deploymentCreatedAt: deployment.created_at ?? null,
        workflow,
        runId: String(runId),
        runAttempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : null,
        runSha: run.head_sha ?? null,
        runStatus: run.status ?? null,
        runConclusion: run.conclusion ?? null,
        state: status?.state ?? null,
        statusId: status?.id ?? null,
        statusCreatedAt: status?.created_at ?? null,
        statusUrl: `https://github.com/${REPO}/actions/runs/${runId}`,
      };
      if (workflow === CHAT_ONLY_WORKFLOW) {
        if (status?.state !== "success" && !backendSupersededByHealthyMutation)
          throw new Error(`UAT One Chat predecessor ${deployment.id} is not successful.`);
        if (status?.state === "success") {
          const receipt = await oneChatReleaseReceipt(runId, run.run_attempt, run);
          if (!hasExactBackendSource) {
            mutation.serviceTargetSha = receipt.target_sha;
            hasExactBackendSource = true;
          }
          backendSupersededByHealthyMutation = true;
        }
      }
      if (workflow === FULL_UAT_WORKFLOW && status?.state === "success") {
        const receipt = await fullUatReleaseAcceptance(runId, run.run_attempt, run);
        if (receipt.scope !== "frontend") {
          hasExactBackendSource = true;
          backendSupersededByHealthyMutation = true;
        }
      }
      mutations.push(mutation);
    }
    if (deployments.length < 100) break;
    if (page === 10) throw new Error("UAT deployment history exceeds the verified 1,000-record window.");
  }
  if (currentAttemptRecords.length > 1)
    throw new Error("More than one UAT environment record matches this workflow attempt.");
  if (!mutations.length)
    throw new Error("No verified UAT service-mutation predecessor exists.");
  // A newest unresolved or failed mutation means serving state is not a safe
  // baseline. Older terminal failures remain in the identity for race checks.
  if (mutations[0].state !== "success")
    throw new Error(`Latest UAT predecessor ${mutations[0].deploymentId} is not successful.`);
  if (mutations[0].workflow === ROLLBACK_WORKFLOW)
    throw new Error("The latest UAT predecessor is a rollback and needs reconciliation.");
  return JSON.stringify({
    serving: {
      sha: servingState.sha,
      serviceHeads: servingState.serviceHeads,
      latestMutationId: servingState.latestMutationId,
      latestBackendMutationId: servingState.latestBackendMutationId,
    },
    mutations,
  });
}

/** Environment records use workflow SHA, including for rollback/rehearsal jobs.
 * Match the healthy release's existing exact-target receipt to that same run.
 * Missing/advisory tagging proof can block a no-op, never authorize one.
 */
async function hasExactReleaseReceipt(state) {
  let statusUrl;
  try { statusUrl = new URL(state.runUrl); } catch { return false; }
  const prefix = `/${REPO}/actions/runs/`;
  if (statusUrl.origin !== "https://github.com" || !statusUrl.pathname.startsWith(prefix)) return false;
  const runId = statusUrl.pathname.slice(prefix.length).match(/^(\d+)(?:\/job\/\d+)?$/)?.[1];
  if (!runId) return false;
  const run = await api(`/actions/runs/${runId}`);
  if (workflowFile(run) !== FULL_UAT_WORKFLOW || run.event !== "workflow_dispatch" ||
    run.head_sha !== state.sha || run.status !== "completed" || run.conclusion !== "success" ||
    !Number.isSafeInteger(run.run_attempt)) return false;
  try {
    const receipt = await fullUatReleaseAcceptance(runId, run.run_attempt, run);
    return receipt.targetSha === state.sha &&
      receipt.serviceHeads.backend === state.serviceHeads?.backend &&
      receipt.serviceHeads.frontend === state.serviceHeads?.frontend;
  } catch {
    return false;
  }
}

async function main() {
  const captureBaseline = args.includes("--capture-uat-baseline");
  const checkBaseline = valueOf("--check-uat-baseline");
  const forwardTarget = valueOf("--assert-forward-from-uat");
  if (forwardTarget !== null) {
    if (!/^[0-9a-f]{40}$/.test(forwardTarget)) throw new Error("A full immutable application SHA is required.");
    git("fetch", "--no-tags", "origin", "main", "uat");
    const current = await uatActualSha();
    const staleServices = Object.entries(current.serviceHeads)
      .filter(([, predecessor]) => !isAncestor(predecessor, forwardTarget))
      .map(([service]) => service);
    if (staleServices.length)
      throw new Error(`Selected UAT SHA ${forwardTarget} does not descend from the current UAT predecessor for serving ${staleServices.join(" and ")} service(s).`);
    console.log(`Selected UAT SHA descends from serving UAT service predecessors ${Object.values(current.serviceHeads).join(", ")}.`);
    return;
  }
  if (captureBaseline || checkBaseline !== null) {
    // The select job has no UAT environment record yet. Lock-time checks compare
    // the exact captured identity without reclassifying their own pending row.
    const servingState = await uatActualSha();
    const snapshot = await uatMutationBaseline(servingState);
    if (captureBaseline) {
      if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
      appendFileSync(process.env.GITHUB_OUTPUT, `snapshot=${snapshot}\n`);
      console.log("Captured current UAT predecessor identity.");
      return;
    }
    if (checkBaseline !== snapshot) {
      throw new Error("The UAT predecessor changed while this deployment waited for its lock.");
    }
    console.log("Current UAT predecessor still matches the selected baseline.");
    return;
  }

  git("fetch", "--no-tags", "origin", "main");
  const mainTipSha = git("rev-parse", "origin/main");
  const uatState = await uatActualSha();
  const uatActual = uatState.sha;

  const range = uatActual ? `${uatActual}..origin/main` : `origin/main~${limit}..origin/main`;
  let shas = [];
  try {
    shas = git("rev-list", `--max-count=${limit}`, range).split("\n").filter(Boolean);
  } catch {
    // `uatActual` is not an ancestor of main — a force-push or a rebased
    // history. Treat as a hard block rather than guessing a range.
    report({
      mainTipSha,
      uatActual,
      decision: "BLOCKED",
      reason: `Cannot enumerate commits after ${uatActual}; main history diverged from the live UAT commit.`,
      targetSha: null,
      candidates: [],
    });
    process.exit(2);
  }

  const candidates = [];
  for (const sha of shas) {
    candidates.push({ sha, gate: await gateFor(sha) });
  }

  const result = reconcileUatTarget({
    mainTipSha,
    uatActualSha: uatActual,
    // The deploy workflow's own concurrency group guarantees single-flight, so
    // an in-flight check here would only ever see this run itself.
    uatDeployingSha: null,
    candidates,
  });

  if (result.targetSha) {
    const guard = assertDeployable({
      targetSha: result.targetSha,
      uatActualSha: uatActual,
      targetGate: "success",
      reachableFromMain: true,
      descendsFromUatActual: uatActual
        ? isAncestor(uatActual, result.targetSha)
        : true,
    });
    if (!guard.ok) {
      report({ mainTipSha, uatActual, ...result, decision: "BLOCKED", reason: guard.reason, candidates });
      process.exit(2);
    }
    const staleServices = Object.entries(uatState.serviceHeads)
      .filter(([, predecessor]) => !isAncestor(predecessor, result.targetSha))
      .map(([service]) => service);
    if (staleServices.length) {
      report({
        mainTipSha,
        uatActual,
        ...result,
        decision: "BLOCKED",
        targetSha: null,
        reason: `Target would regress the serving UAT ${staleServices.join(" and ")} service predecessor.`,
        candidates,
      });
      process.exit(2);
    }
  }

  const confirmedNoOp = allowNoOp && result.decision === "NO_OP" &&
    uatState.verified && uatActual === mainTipSha && await hasExactReleaseReceipt(uatState);
  if (allowNoOp && result.decision === "NO_OP" && !confirmedNoOp) {
    result.decision = "BLOCKED";
    result.reason = "Cannot confirm current UAT from the newest successful deployment and its exact-target healthy release receipt.";
  }
  report({ mainTipSha, uatActual, ...result, candidates });

  if (writeGithubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `sha=${result.targetSha ?? ""}\ndecision=${result.decision}\nuat_actual_sha=${uatActual ?? ""}\nreason=${result.reason}\n`,
    );
  }
  process.exit(result.targetSha || confirmedNoOp ? 0 : 3);
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function report({ mainTipSha, uatActual, decision, targetSha, reason, blockedAtSha, candidates }) {
  const tip = candidates.find((c) => c.sha === mainTipSha);
  console.log(`repository: ${REPO}`);
  console.log(`main_tip_sha: ${mainTipSha}`);
  console.log(`main_tip_gate: ${tip ? tip.gate : uatActual === mainTipSha ? "already-deployed" : "unknown"}`);
  console.log(`uat_actual_sha: ${uatActual ?? "unknown"}`);
  console.log(`target_sha: ${targetSha ?? "none"}`);
  console.log(`target_gate_name: ${GATE_NAME}`);
  console.log(`decision: ${decision}`);
  console.log(`reason: ${reason}`);
  if (blockedAtSha) console.log(`blocked_at_sha: ${blockedAtSha}`);
  console.log("candidates (newest first):");
  for (const c of candidates) console.log(`  ${c.sha} gate=${c.gate}`);
}

main().catch((error) => {
  console.error(`UAT target selection failed: ${error.message}`);
  process.exit(1);
});
