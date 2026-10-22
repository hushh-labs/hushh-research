import assert from "node:assert/strict";
import test from "node:test";

import {
  isCandidateAssetUnavailable,
  isCandidateStaticAsset5xx,
} from "./analytics-smoke-failure.mjs";

const origin = "https://analytics-candidate---hushh-webapp.example.run.app";

test("only same-origin candidate static asset 5xx is counted", () => {
  assert.equal(
    isCandidateStaticAsset5xx({
      candidateOrigin: origin,
      responseUrl: `${origin}/_next/static/chunks/app.js`,
      status: 500,
    }),
    true,
  );
  for (const [responseUrl, status] of [
    [`${origin}/_next/static/chunks/app.js`, 404],
    [`${origin}/login`, 500],
    ["https://other.example.run.app/_next/static/chunks/app.js", 503],
  ]) {
    assert.equal(
      isCandidateStaticAsset5xx({ candidateOrigin: origin, responseUrl, status }),
      false,
    );
  }
});

test("initial measurement timeout after candidate static 5xx allows one retry", () => {
  assert.equal(
    isCandidateAssetUnavailable({
      phase: "measurement_id",
      reason: "page.waitForFunction: Timeout 120000ms exceeded.",
      failedAssetStatuses: [500],
      observedEventNames: [],
      observedMeasurementIds: [],
      observedGaCollectEvents: [],
    }),
    true,
  );
});

test("clean asset loads and later analytics failures do not get a retry", () => {
  const base = {
    phase: "measurement_id",
    reason: "page.waitForFunction: Timeout 120000ms exceeded.",
    failedAssetStatuses: [500],
    observedEventNames: [],
    observedMeasurementIds: [],
    observedGaCollectEvents: [],
  };
  assert.equal(isCandidateAssetUnavailable({ ...base, failedAssetStatuses: [] }), false);
  assert.equal(isCandidateAssetUnavailable({ ...base, failedAssetStatuses: [404] }), false);
  assert.equal(isCandidateAssetUnavailable({ ...base, reason: "page crashed" }), false);
  assert.equal(isCandidateAssetUnavailable({ ...base, phase: "later_checks" }), false);
  assert.equal(
    isCandidateAssetUnavailable({ ...base, observedMeasurementIds: ["G-H1KGXGZTCF"] }),
    false,
  );
  assert.equal(
    isCandidateAssetUnavailable({ ...base, observedEventNames: ["page_view"] }),
    false,
  );
  assert.equal(
    isCandidateAssetUnavailable({ ...base, observedGaCollectEvents: ["page_view"] }),
    false,
  );
});
