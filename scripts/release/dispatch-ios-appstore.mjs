#!/usr/bin/env node
/**
 * One-click production iOS App Store release trigger.
 *
 * Wraps the GitHub Actions workflow "Release iOS to App Store"
 * (.github/workflows/release-ios-appstore.yml): it resolves the release SHA
 * (the current tip of origin/main by default — i.e. what is live), asks for an
 * explicit confirmation, dispatches the workflow with `gh workflow run`, then
 * streams the run with `gh run watch`.
 *
 * The Apple-facing work (build → sign with production entitlements → archive →
 * upload to App Store Connect → prepare the App Store version) all runs on the
 * GitHub macOS runner, because GCP has no macOS instances and local builds hang
 * inside iCloud Drive. This script is the thin, auditable dispatcher.
 *
 * SAFETY / IRREVERSIBILITY
 *   By default this prepares the release up to — but NOT including — the final,
 *   irreversible "Submit for App Store Review" action. Submitting for public
 *   review requires BOTH flags together:
 *       --submit --ack-blockers
 *   which map to the workflow's `submit_for_review=true` + `ack_publish_blockers=true`.
 *   The workflow itself re-checks that both are set. Never pass --submit from an
 *   automated context; it publishes to real users and cannot be undone.
 *
 * Usage:
 *   node scripts/release/dispatch-ios-appstore.mjs                 # prepare-only, SHA=origin/main
 *   node scripts/release/dispatch-ios-appstore.mjs --sha <sha>     # pin an explicit green SHA
 *   node scripts/release/dispatch-ios-appstore.mjs --dry-run       # archive+sign only, no upload
 *   node scripts/release/dispatch-ios-appstore.mjs --notes "..."   # annotate the run summary
 *   node scripts/release/dispatch-ios-appstore.mjs --submit --ack-blockers   # IRREVERSIBLE public submit
 *   node scripts/release/dispatch-ios-appstore.mjs --yes           # skip the interactive confirm
 *   node scripts/release/dispatch-ios-appstore.mjs --no-watch      # dispatch and return immediately
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const WORKFLOW = "Release iOS to App Store";
const REF = "main";

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
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
    notes: "",
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
      case "--notes":
        opts.notes = argv[++i] ?? "";
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
            "[--sha <sha>] [--dry-run] [--submit --ack-blockers] [--notes <text>] [--yes] [--no-watch]",
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

function findLatestRunId() {
  // gh workflow run does not return the run id; grab the newest run for this workflow.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = run(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        WORKFLOW,
        "--limit",
        "1",
        "--json",
        "databaseId,headBranch,createdAt",
      ],
      { capture: true },
    );
    if (res.status === 0 && res.stdout.trim()) {
      try {
        const rows = JSON.parse(res.stdout);
        if (rows.length > 0 && rows[0].databaseId) return String(rows[0].databaseId);
      } catch {
        /* retry */
      }
    }
    // brief backoff for the run to register
    spawnSync("sleep", ["2"]);
  }
  return null;
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

  ensureGhReady();
  const sha = resolveSha(opts.sha);

  const mode = opts.dryRun
    ? "DRY RUN (archive + sign only; no upload, no App Store Connect changes)"
    : opts.submit
      ? "UPLOAD + SUBMIT FOR PUBLIC APP STORE REVIEW (IRREVERSIBLE)"
      : "UPLOAD + PREPARE App Store version (no review submission)";

  console.log("\nProduction iOS App Store release");
  console.log("────────────────────────────────");
  console.log(`  Workflow : ${WORKFLOW}`);
  console.log(`  Ref      : ${REF}`);
  console.log(`  SHA      : ${sha}`);
  console.log(`  Backend  : PRODUCTION (hushh-pda / api.hushh.ai)`);
  console.log(`  Mode     : ${mode}`);
  if (opts.notes) console.log(`  Notes    : ${opts.notes}`);
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

  const ghArgs = ["workflow", "run", WORKFLOW, "--ref", REF, "-f", `sha=${sha}`];
  if (opts.dryRun) ghArgs.push("-f", "dry_run=true");
  if (opts.notes) ghArgs.push("-f", `notes=${opts.notes}`);
  if (opts.submit) {
    ghArgs.push("-f", "submit_for_review=true", "-f", "ack_publish_blockers=true");
  }

  console.log(`\n$ gh ${ghArgs.join(" ")}\n`);
  const dispatch = run("gh", ghArgs);
  if (dispatch.status !== 0) fail("gh workflow run failed. See the output above.");

  if (!opts.watch) {
    console.log("Dispatched. Watch it with:  gh run watch --workflow \"" + WORKFLOW + "\"");
    return;
  }

  const runId = findLatestRunId();
  if (!runId) {
    console.log(
      "Dispatched, but could not resolve the run id automatically.\n" +
        `Watch it with:  gh run watch --workflow "${WORKFLOW}"`,
    );
    return;
  }
  console.log(`\nWatching run ${runId} …\n`);
  const watch = run("gh", ["run", "watch", runId, "--exit-status"]);
  process.exit(watch.status ?? 0);
}

main().catch((err) => fail(err?.message ?? String(err)));
