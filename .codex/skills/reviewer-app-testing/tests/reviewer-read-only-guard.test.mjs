import assert from "node:assert/strict";
import test from "node:test";

import { installReadOnlyMutationGuard } from "../scripts/reviewer-session-harness.mjs";

const APP_ORIGIN = "https://uat.one.hushh.ai";

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
