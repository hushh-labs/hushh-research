// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchInputs, dispatchedRunId, parseArgs, parseMarketingVersion, requireCompletedRelease } from "./dispatch-ios-appstore.mjs";

test("dispatch binds to the returned run, never a concurrent latest run", () => {
  const repository = "example/release";
  assert.equal(dispatchedRunId({ workflow_run_id: 123, html_url: "https://github.com/example/release/actions/runs/123" }, repository), "123");
  for (const response of [{}, { workflow_run_id: 123, html_url: "https://github.com/example/release/actions/runs/124" }]) {
    assert.throws(() => dispatchedRunId(response, repository), /unverified/);
  }
});

test("a successful watcher cannot authorize a failed or different release", () => {
  const completed = { databaseId: 123, workflowName: "Release iOS to App Store", event: "workflow_dispatch", headBranch: "main", status: "completed", conclusion: "success" };
  assert.doesNotThrow(() => requireCompletedRelease(completed, "123"));
  for (const changed of [{ conclusion: "failure" }, { status: "in_progress" }, { databaseId: 124 }, { headBranch: "feature" }]) {
    assert.throws(() => requireCompletedRelease({ ...completed, ...changed }, "123"), /not been verified/);
  }
});

test("an explicit packaging version preserves production source and review gates", () => {
  const sha = "a".repeat(40);
  const opts = parseArgs(["--backend", "production", "--marketing-version", "1.4.1"]);
  assert.deepEqual(buildDispatchInputs(opts, sha), {
    sha, backend_target: "production", marketing_version: "1.4.1",
    dry_run: "false", submit_for_review: "false", release_after_approval: "false",
  });
  assert.equal(Object.hasOwn(buildDispatchInputs(parseArgs([]), sha), "marketing_version"), false);
});

test("malformed packaging versions cannot reach dispatch", () => {
  for (const value of [undefined, "", "1.4", "1.4.1.2", "01.4.1", "1.4.1-beta", "1.4.1\nINJECTED=true", "$(touch injected)"]) {
    assert.throws(() => parseMarketingVersion(value), /three numeric components/);
  }
  assert.equal(parseMarketingVersion("1.4.1"), "1.4.1");
});

test("public submissions cannot target UAT even when the CLI is bypassed", () => {
  const sha = "b".repeat(40);
  for (const flags of [{ submit: true }, { releaseAfterApproval: true }]) {
    assert.throws(() => buildDispatchInputs({ backend: "uat", ...flags }, sha), /production backend/);
    assert.doesNotThrow(() => buildDispatchInputs({ backend: "production", ...flags }, sha));
  }
  assert.doesNotThrow(() => buildDispatchInputs({ backend: "uat", dryRun: true }, sha));
});
