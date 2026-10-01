// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchedRunId, requireCompletedRelease } from "./dispatch-ios-appstore.mjs";

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
