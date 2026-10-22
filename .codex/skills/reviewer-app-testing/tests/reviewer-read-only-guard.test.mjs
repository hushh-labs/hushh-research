import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { installReadOnlyMutationGuard, installReviewerBridge } from "../scripts/reviewer-session-harness.mjs";
import { secretManagerValue } from "../scripts/reviewer-rehearsal-preflight.mjs";

const APP_ORIGIN = "https://uat.one.hushh.ai";

test("canonical secret reads resolve host command shims without printing their contents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-reviewer-cli-"));
  const windows = process.platform === "win32";
  const shim = path.join(directory, windows ? "gcloud.cmd" : "gcloud");
  fs.writeFileSync(shim, windows ? "@echo off\r\necho reviewer-fixture-value\r\n"
    : "#!/bin/sh\nprintf 'reviewer-fixture-value\\n'\n", { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previousPath || ""}`;
  try {
    assert.equal(secretManagerValue("fixture-project", "REVIEWER_UID"), "reviewer-fixture-value");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.unlinkSync(shim);
    fs.rmdirSync(directory);
  }
});

test("explicit-login bridge leaves logout landing anonymous without unlock material", () => {
  for (const [pathname, origin, frame, permitted] of [
    ["/login", APP_ORIGIN, false, true], ["/", APP_ORIGIN, false, false],
    ["/one/pkm", APP_ORIGIN, false, false], ["/login", "https://other.example", false, false],
    ["/login", APP_ORIGIN, true, false],
  ]) {
    const window = { __HUSHH_NATIVE_TEST__: { vaultPassphrase: "old", reviewerSessionPassphrase: "old" } };
    window.top = frame ? {} : window;
    vm.runInNewContext(`(${installReviewerBridge.toString()})(config)`, { window,
      location: { pathname, origin }, config: { explicitLoginOnly: true, appOrigin: APP_ORIGIN,
        expectedUserId: "reviewer", vaultPassphrase: "test-unlock", reviewerSessionPassphrase: "test-mint",
        reviewerMutationPolicy: "bounded_mutation", reviewerAuthMode: "custom_token" } });
    const bridge = window.__HUSHH_NATIVE_TEST__;
    assert.equal(bridge.autoReviewerLogin, permitted);
    assert.equal(bridge.vaultPassphrase, permitted ? "test-unlock" : undefined);
    assert.equal(bridge.reviewerSessionPassphrase, permitted ? "test-mint" : undefined);
  }
});

function requestFor(handler, method, url) {
  const result = { forwarded: false, response: null };
  return handler({
    request: () => ({ method: () => method, url: () => url }),
    continue: async () => { result.forwarded = true; },
    fulfill: async (response) => { result.response = response; },
  }).then(() => result);
}

async function guardedContext() {
  let handler;
  const guard = await installReadOnlyMutationGuard({
    route: async (_pattern, callback) => { handler = callback; },
  }, { appOrigin: APP_ORIGIN });
  return { guard, handler };
}

test("optional first-connection insight does not mutate the shared reviewer", async () => {
  const { guard, handler } = await guardedContext();
  const result = await requestFor(handler, "POST", `${APP_ORIGIN}/api/one/first-connect-insights`);
  assert.equal(result.forwarded, false);
  assert.equal(result.response?.status, 200);
  assert.deepEqual(JSON.parse(result.response.body), { status: "unavailable" });
  assert.doesNotThrow(() => guard.assertNoBlockedMutation());
});

test("the exception does not admit a foreign origin or another POST", async () => {
  const { guard, handler } = await guardedContext();
  const foreign = await requestFor(handler, "POST", "https://other.example/api/one/first-connect-insights");
  const unrelated = await requestFor(handler, "POST", `${APP_ORIGIN}/api/one/other-write`);
  assert.equal(foreign.forwarded, false);
  assert.equal(foreign.response?.status, 409);
  assert.equal(unrelated.forwarded, false);
  assert.equal(unrelated.response?.status, 409);
  assert.throws(() => guard.assertNoBlockedMutation(), /blocked state-changing request/);
});
