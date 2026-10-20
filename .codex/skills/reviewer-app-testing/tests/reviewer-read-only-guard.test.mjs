import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { installReadOnlyMutationGuard, installReviewerBridge } from "../scripts/reviewer-session-harness.mjs";

const APP_ORIGIN = "https://uat.one.hushh.ai";

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
