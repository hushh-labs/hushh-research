#!/usr/bin/env node
/**
 * One-click production iOS App Store release trigger.
 *
 * Wraps the GitHub Actions workflow "Release iOS to App Store"
 * (.github/workflows/release-ios-appstore.yml): it resolves the release SHA
 * (the current tip of origin/main by default — i.e. what is live), asks for an
 * explicit confirmation, dispatches through GitHub's versioned REST API, then
 * streams the run with `gh run watch`.
 *
 * The Apple-facing work (build the selected backend's app → sign with production APNs
 * entitlements → archive → upload to App Store Connect → set What's New →
 * attach the build → optionally submit for review) all runs on the GitHub macOS
 * runner, because GCP has no macOS instances and local builds hang inside iCloud
 * Drive. This script is the thin, auditable dispatcher.
 *
 * BACKEND: `--backend uat` (default) ships the same UAT backend + shared Firebase
 * authority (hushh-pda; config stored in hushh-pda-uat) as TestFlight. `--backend
 * production` maps to the workflow's `backend_target=production`: the binary
 * talks to one.hushh.ai and the production API, with the same shared Firebase
 * identity.
 *
 * SAFETY / IRREVERSIBILITY
 *   By default this prepares the release up to — but NOT including — the final,
 *   irreversible "Submit for App Store Review" action. One-click submission maps
 *   to the workflow's `submit_for_review=true`. On this CLI path it additionally
 *   requires a local `--ack-blockers` acknowledgement so a public submit is never
 *   fired by accident or from an automated context; it publishes to real users
 *   and cannot be undone. Clear the publish-safety blockers first.
 *
 * Usage:
 *   node scripts/release/dispatch-ios-appstore.mjs                 # prepare-only, SHA=origin/main
 *   node scripts/release/dispatch-ios-appstore.mjs --sha <sha>     # pin an explicit green SHA
 *   node scripts/release/dispatch-ios-appstore.mjs --dry-run       # archive+sign only, no upload
 *   node scripts/release/dispatch-ios-appstore.mjs --backend production  # binary talks to production
 *   node scripts/release/dispatch-ios-appstore.mjs --whats-new "..."  # App Store release notes for this version
 *   node scripts/release/dispatch-ios-appstore.mjs --notes "..."   # annotate the run summary
 *   node scripts/release/dispatch-ios-appstore.mjs --submit --ack-blockers   # IRREVERSIBLE one-click public submit
 *   node scripts/release/dispatch-ios-appstore.mjs --yes           # skip the interactive confirm
 *   node scripts/release/dispatch-ios-appstore.mjs --no-watch      # dispatch and return immediately
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const WORKFLOW = "Release iOS to App Store";
const REF = "main";

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function run(cmd, args, { capture = false, input } = {}) {
  const res = spawnSync(cmd, args, {
    stdio: capture ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    input,
  });
  if (res.error) fail(`Failed to run ${cmd}: ${res.error.message}`);
  return res;
}

function parseArgs(argv) {
  const opts = {
    sha: null,
    dryRun: false,
    submit: false,
    ackBlockers: false,
    releaseAfterApproval: false,
    whatsNew: "",
    notes: "",
    backend: "uat",
    yes: false,
    watch: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--sha":
        opts.sha = argv[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--submit":
        opts.submit = true;
        break;
      case "--ack-blockers":
        opts.ackBlockers = true;
        break;
      case "--release-after-approval":
        opts.releaseAfterApproval = true;
        break;
      case "--whats-new":
        opts.whatsNew = argv[++i] ?? "";
        break;
      case "--notes":
        opts.notes = argv[++i] ?? "";
        break;
      case "--backend":
        opts.backend = argv[++i] ?? "";
        if (!["uat", "production"].includes(opts.backend)) {
          fail(`--backend must be "uat" or "production", got "${opts.backend}".`);
        }
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--no-watch":
        opts.watch = false;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node scripts/release/dispatch-ios-appstore.mjs " +
            "[--sha <sha>] [--dry-run] [--backend uat|production] [--whats-new <text>] [--submit --ack-blockers [--release-after-approval]] [--notes <text>] [--yes] [--no-watch]",
        );
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function ensureGhReady() {
  const version = run("gh", ["--version"], { capture: true });
  if (version.status !== 0) {
    fail("GitHub CLI (`gh`) is not installed. Install it: https://cli.github.com/");
  }
  const auth = run("gh", ["auth", "status"], { capture: true });
  if (auth.status !== 0) {
    fail("GitHub CLI is not authenticated. Run: gh auth login");
  }
}

function resolveSha(explicit) {
  if (explicit) return explicit.trim();
  // Default to the live tip of main. Fetch first so we dispatch what's actually
  // on the remote, not a stale local ref.
  run("git", ["fetch", "--quiet", "origin", "main"], { capture: true });
  const res = run("git", ["rev-parse", "origin/main"], { capture: true });
  if (res.status !== 0 || !res.stdout.trim()) {
    fail("Could not resolve origin/main. Pass an explicit --sha <sha>.");
  }
  return res.stdout.trim();
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    fail("Non-interactive shell: re-run with --yes to confirm the dispatch explicitly.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase();
}

export function dispatchedRunId(response, repository) {
  const id = response.workflow_run_id;
  if (!Number.isSafeInteger(id) || id <= 0 ||
      response.html_url !== `https://github.com/${repository}/actions/runs/${id}`) {
    throw new Error("Dispatch identity is unverified. Do not redispatch or select the newest run; inspect GitHub first.");
  }
  return String(id);
}

export function requireCompletedRelease(result, runId) {
  if (String(result.databaseId) !== runId || result.workflowName !== WORKFLOW ||
      result.event !== "workflow_dispatch" || result.headBranch !== REF ||
      result.status !== "completed" || result.conclusion !== "success") {
    throw new Error(`Release run ${runId} has not been verified as completed successfully.`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.submit && !opts.ackBlockers) {
    fail(
      "--submit requires --ack-blockers. Public App Store review submission is IRREVERSIBLE.\n" +
        "  Clear every publish-safety blocker in docs/guides/mobile/release-ios-appstore.md first,\n" +
        "  then re-run with:  --submit --ack-blockers",
    );
  }
  if (opts.submit && opts.dryRun) {
    fail("--submit and --dry-run are mutually exclusive.");
  }
  if (opts.releaseAfterApproval && !opts.submit) fail("--release-after-approval requires --submit --ack-blockers.");

  ensureGhReady();
  const sha = resolveSha(opts.sha);

  const mode = opts.dryRun
    ? "DRY RUN (archive + sign only; no upload, no App Store Connect changes)"
    : opts.submit
      ? "UPLOAD + SUBMIT FOR PUBLIC APP STORE REVIEW (IRREVERSIBLE)"
      : "UPLOAD + PREPARE App Store version (no review submission)";

  console.log("\nProduction iOS App Store release");
  console.log("────────────────────────────────");
  console.log(`  Workflow  : ${WORKFLOW}`);
  console.log(`  Ref       : ${REF}`);
  console.log(`  SHA       : ${sha}`);
  console.log(
    `  Backend   : ${opts.backend === "production" ? "PRODUCTION (hushh-pda, one.hushh.ai)" : "UAT (hushh-pda-uat), same as TestFlight"}`,
  );
  console.log(`  Mode      : ${mode}`);
  console.log(`  Publication: ${opts.releaseAfterApproval ? "automatic after Apple approval" : "manual; submission alone does not publish"}`);
  if (!opts.dryRun) {
    console.log(`  What's New : ${opts.whatsNew || "(workflow default)"}`);
  }
  if (opts.notes) console.log(`  Notes     : ${opts.notes}`);
  console.log("");

  if (!opts.yes) {
    const expected = opts.submit ? "submit" : "yes";
    const prompt = opts.submit
      ? 'Type "submit" to CONFIRM an IRREVERSIBLE public App Store submission: '
      : 'Type "yes" to dispatch: ';
    const answer = await confirm(prompt);
    if (answer !== expected) {
      console.log("Aborted. No workflow dispatched.");
      process.exit(0);
    }
  }

  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { capture: true });
  const repository = repo.stdout.trim();
  if (repo.status !== 0 || !/^[\w.-]+\/[\w.-]+$/.test(repository)) fail("Could not resolve the target repository.");
  const inputs = { sha, backend_target: opts.backend, dry_run: String(opts.dryRun), submit_for_review: String(opts.submit), release_after_approval: String(opts.releaseAfterApproval) };
  if (opts.whatsNew) inputs.whats_new = opts.whatsNew;
  if (opts.notes) inputs.notes = opts.notes;
  // The versioned dispatch API returns this dispatch's run ID. Never guess from
  // a latest-run list: concurrent operators can otherwise watch the wrong release.
  const dispatch = run("gh", ["api", "--method", "POST",
    `repos/${repository}/actions/workflows/release-ios-appstore.yml/dispatches`,
    "-H", "X-GitHub-Api-Version: 2026-03-10", "--input", "-"],
    { capture: true, input: JSON.stringify({ ref: REF, inputs }) });
  if (dispatch.status !== 0) fail("Dispatch failed or its outcome is uncertain. Inspect GitHub before retrying.");
  const runId = dispatchedRunId(JSON.parse(dispatch.stdout), repository);
  console.log(`Dispatched: https://github.com/${repository}/actions/runs/${runId}`);

  if (!opts.watch) {
    console.log(`Watch it with: gh run watch ${runId} --exit-status`);
    return;
  }

  console.log(`\nWatching run ${runId} …\n`);
  const watch = run("gh", ["run", "watch", runId, "--exit-status"]);
  if (watch.status !== 0) fail(`Release watcher failed for run ${runId}. Inspect its terminal state.`);
  const result = run("gh", ["run", "view", runId, "--json",
    "databaseId,workflowName,event,headBranch,status,conclusion"], { capture: true });
  if (result.status !== 0) fail(`Could not verify release run ${runId}.`);
  requireCompletedRelease(JSON.parse(result.stdout), runId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(err?.message ?? String(err)));
}
