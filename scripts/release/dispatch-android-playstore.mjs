#!/usr/bin/env node
/**
 * One-click Android Google Play Store release trigger.
 *
 * Wraps the GitHub Actions workflow "Ship Android to Google Play Store"
 * (.github/workflows/ship-android-playstore.yml): it resolves the release SHA
 * (the current tip of origin/main by default), asks for confirmation, dispatches
 * the workflow with `gh workflow run`, then streams the run with `gh run watch`.
 *
 * Usage:
 *   node scripts/release/dispatch-android-playstore.mjs                   # internal track, SHA=origin/main
 *   node scripts/release/dispatch-android-playstore.mjs --track production # ship to production track
 *   node scripts/release/dispatch-android-playstore.mjs --sha <sha>       # pin an explicit green SHA
 *   node scripts/release/dispatch-android-playstore.mjs --dry-run         # build+sign .aab only, no upload
 *   node scripts/release/dispatch-android-playstore.mjs --yes             # skip the interactive confirm
 *   node scripts/release/dispatch-android-playstore.mjs --no-watch        # dispatch and return immediately
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const WORKFLOW = ".github/workflows/ship-android-playstore-app.yml";
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
    track: "internal",
    dryRun: false,
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
      case "--track":
        opts.track = argv[++i] ?? "internal";
        break;
      case "--dry-run":
        opts.dryRun = true;
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
        console.log(`
Usage:
  node scripts/release/dispatch-android-playstore.mjs [options]

Options:
  --track <internal|alpha|beta|production> Target Google Play track (default: internal)
  --sha <sha>                              Pin an explicit git SHA from main
  --dry-run                                Build & sign .aab but do not upload
  --notes "<text>"                         Release notes
  --yes, -y                                Skip confirmation prompt
  --no-watch                               Dispatch without watching run logs
`);
        process.exit(0);
      default:
        fail(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

async function confirm(promptText) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${promptText} [y/N]: `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Verify gh CLI is available
  const ghCheck = run("gh", ["--version"], { capture: true });
  if (ghCheck.status !== 0) {
    fail("GitHub CLI ('gh') is required to dispatch the release workflow.");
  }

  // Resolve target SHA
  let targetSha = opts.sha;
  if (!targetSha) {
    const rev = run("git", ["rev-parse", `origin/${REF}`], { capture: true });
    if (rev.status !== 0) fail(`Cannot resolve origin/${REF}`);
    targetSha = rev.stdout.trim();
  }

  console.log(`
======================================================
  🤖 Hushh One Android Play Store Release Trigger
======================================================
  Target Track:  ${opts.track}
  Target SHA:    ${targetSha}
  Dry Run:       ${opts.dryRun}
  Notes:         ${opts.notes || "(none)"}
======================================================
`);

  if (!opts.yes) {
    const ok = await confirm("Proceed with dispatching Android Play Store release?");
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  const fields = [
    "-f", `sha=${targetSha}`,
    "-f", `track=${opts.track}`,
    "-f", `dry_run=${opts.dryRun}`,
    "-f", `notes=${opts.notes}`,
  ];

  console.log(`Dispatching workflow '${WORKFLOW}' on branch '${REF}'...`);
  const dispatch = run("gh", ["workflow", "run", WORKFLOW, "--ref", REF, ...fields]);
  if (dispatch.status !== 0) fail("Workflow dispatch failed.");

  console.log("\n✔ Workflow dispatched successfully.");

  if (opts.watch) {
    console.log("\nWaiting for workflow run to start...\n");
    await new Promise((r) => setTimeout(r, 5000));
    run("gh", ["run", "watch"]);
  }
}

main().catch((err) => fail(err.stack || err.message));
