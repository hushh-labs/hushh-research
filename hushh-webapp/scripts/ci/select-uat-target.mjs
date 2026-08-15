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
 *   node hushh-webapp/scripts/ci/select-uat-target.mjs [--limit 20] [--github-output]
 *
 * Requires GITHUB_TOKEN and GITHUB_REPOSITORY (both present in Actions).
 * Exits non-zero when there is nothing safe to deploy, so a caller that
 * wants a target can fail closed.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { assertDeployable, reconcileUatTarget } from "./uat-target-selection.mjs";

const GATE_NAME = "Main Post-Merge Smoke";
const REPO = process.env.GITHUB_REPOSITORY || "hushh-labs/hushh-research";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const args = process.argv.slice(2);
const limit = Number(valueOf("--limit") || 20);
const writeGithubOutput = args.includes("--github-output");

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function git(...a) {
  return execFileSync("git", a, { encoding: "utf8" }).trim();
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

/** That commit's own gate — never a branch status, never a PR check. */
async function gateFor(sha) {
  const payload = await api(`/commits/${sha}/check-runs?per_page=100`);
  const runs = (payload.check_runs || []).filter((run) =>
    String(run.name || "").includes(GATE_NAME),
  );
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

async function uatActualSha() {
  const deployments = await api("/deployments?environment=uat&per_page=10");
  for (const deployment of deployments) {
    const statuses = await api(`/deployments/${deployment.id}/statuses?per_page=10`);
    if (statuses.some((s) => s.state === "success")) return deployment.sha;
  }
  // Fall back to the newest record. Better a slightly conservative baseline
  // than none: an over-cautious `uat_actual` can only make the selector refuse
  // to move, never make it move somewhere unproven.
  return deployments[0]?.sha ?? null;
}

async function main() {
  git("fetch", "--no-tags", "origin", "main");
  const mainTipSha = git("rev-parse", "origin/main");
  const uatActual = await uatActualSha();

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
  }

  report({ mainTipSha, uatActual, ...result, candidates });

  if (writeGithubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `sha=${result.targetSha ?? ""}\ndecision=${result.decision}\n`,
    );
  }
  process.exit(result.targetSha ? 0 : 3);
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
