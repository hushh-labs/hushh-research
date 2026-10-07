#!/usr/bin/env node
/**
 * Manual Android Google Play production release dispatcher.
 *
 * The workflow resolves an exact green main SHA, builds against the UAT backend
 * (which must already be serving that exact SHA), signs the AAB with the existing
 * upload key, and uploads directly to Google Play's production track. There are
 * no test track or scheduled release modes.
 *
 * Usage:
 *   node scripts/release/dispatch-android-playstore.mjs
 *   node scripts/release/dispatch-android-playstore.mjs --sha <green-main-sha>
 *   node scripts/release/dispatch-android-playstore.mjs --dry-run
 *   node scripts/release/dispatch-android-playstore.mjs --notes "Release summary"
 *   node scripts/release/dispatch-android-playstore.mjs --no-watch
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const WORKFLOW_FILE = "ship-android-playstore-v1.yml";
const WORKFLOW_NAME = "Ship Android to Google Play Store";
const REF = "main";

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function run(cmd, args, { capture = false, input } = {}) {
  const result = spawnSync(cmd, args, {
    stdio: capture ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    input,
  });
  if (result.error) fail(`Failed to run ${cmd}: ${result.error.message}`);
  return result;
}

function parseArgs(argv) {
  const options = {
    sha: null,
    dryRun: false,
    notes: "",
    watch: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--sha":
        options.sha = argv[++index] ?? "";
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--notes":
        options.notes = argv[++index] ?? "";
        break;
      case "--no-watch":
        options.watch = false;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node scripts/release/dispatch-android-playstore.mjs " +
            "[--sha <green-main-sha>] [--dry-run] [--notes <text>] [--no-watch]",
        );
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function ensureGitHubCli() {
  const version = run("gh", ["--version"], { capture: true });
  if (version.status !== 0) fail("GitHub CLI (`gh`) is required.");
  const auth = run("gh", ["auth", "status"], { capture: true });
  if (auth.status !== 0) fail("GitHub CLI is not authenticated. Run: gh auth login");
}

function resolveSha(explicitSha) {
  if (explicitSha) return explicitSha.trim();
  const fetch = run("git", ["fetch", "--quiet", "origin", REF], { capture: true });
  if (fetch.status !== 0) fail("Could not refresh origin/main.");
  const revision = run("git", ["rev-parse", `origin/${REF}`], { capture: true });
  if (revision.status !== 0 || !revision.stdout.trim()) {
    fail("Could not resolve origin/main. Pass --sha <green-main-sha> explicitly.");
  }
  return revision.stdout.trim();
}

async function confirm(expected, prompt) {
  if (!process.stdin.isTTY) {
    fail("Production dispatch requires an interactive confirmation.");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => readline.question(prompt, resolve));
  readline.close();
  return answer.trim().toLowerCase() === expected;
}

export function dispatchedRunId(response, repository) {
  const id = response.workflow_run_id;
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    response.html_url !== `https://github.com/${repository}/actions/runs/${id}`
  ) {
    throw new Error(
      "Dispatch identity is unverified. Do not redispatch or select the newest run; inspect GitHub first.",
    );
  }
  return String(id);
}

export function requireCompletedRelease(result, runId) {
  if (
    String(result.databaseId) !== runId ||
    result.workflowName !== WORKFLOW_NAME ||
    result.event !== "workflow_dispatch" ||
    result.headBranch !== REF ||
    result.status !== "completed" ||
    result.conclusion !== "success"
  ) {
    throw new Error(`Android release run ${runId} has not been verified as completed successfully.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureGitHubCli();
  const sha = resolveSha(options.sha);
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("Release SHA must be a full 40-character commit SHA.");

  const mode = options.dryRun
    ? "DRY RUN (query Play, build, sign, and verify; no upload)"
    : "LIVE PRODUCTION ROLLOUT";
  console.log("\nHussh One Android Google Play release");
  console.log("─────────────────────────────────────");
  console.log(`  Workflow : ${WORKFLOW_NAME}`);
  console.log(`  Ref      : ${REF}`);
  console.log(`  SHA      : ${sha}`);
  console.log("  Runtime  : UAT backend (hushh-pda-uat)");
  console.log("  Package  : com.hussh.app");
  console.log("  Track    : production");
  console.log(`  Mode     : ${mode}`);
  if (options.notes) console.log(`  Notes    : ${options.notes}`);
  console.log("");

  const expected = options.dryRun ? "dry run" : "release production";
  const approved = await confirm(
    expected,
    `Type "${expected}" to confirm this ${options.dryRun ? "verification run" : "live production release"}: `,
  );
  if (!approved) {
    console.log("Aborted. No workflow dispatched.");
    return;
  }

  const repositoryResult = run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { capture: true },
  );
  const repository = repositoryResult.stdout.trim();
  if (repositoryResult.status !== 0 || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    fail("Could not resolve the target GitHub repository.");
  }

  const inputs = { sha, dry_run: String(options.dryRun) };
  if (options.notes) inputs.notes = options.notes;
  const dispatch = run(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "--input",
      "-",
    ],
    { capture: true, input: JSON.stringify({ ref: REF, inputs }) },
  );
  if (dispatch.status !== 0) {
    fail("Dispatch failed or its outcome is uncertain. Inspect GitHub before retrying.");
  }
  const runId = dispatchedRunId(JSON.parse(dispatch.stdout), repository);
  console.log(`Dispatched: https://github.com/${repository}/actions/runs/${runId}`);

  if (!options.watch) {
    console.log(`Watch it with: gh run watch ${runId} --exit-status`);
    return;
  }

  const watch = run("gh", ["run", "watch", runId, "--exit-status"]);
  if (watch.status !== 0) fail(`Release watcher failed for run ${runId}. Inspect its terminal state.`);
  const result = run(
    "gh",
    [
      "run",
      "view",
      runId,
      "--json",
      "databaseId,workflowName,event,headBranch,status,conclusion",
    ],
    { capture: true },
  );
  if (result.status !== 0) fail(`Could not verify Android release run ${runId}.`);
  requireCompletedRelease(JSON.parse(result.stdout), runId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error?.message ?? String(error)));
}
