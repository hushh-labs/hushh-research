// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseArgs, validateReleaseTarget } from "./dispatch-android-playstore.mjs";

test("the UAT-backed workflow cannot publish publicly or silently select PROD data", () => {
  assert.equal(parseArgs([]).track, "internal");
  assert.throws(() => validateReleaseTarget({ track: "production", dryRun: false }), /targets UAT/);
  assert.doesNotThrow(() => validateReleaseTarget({ track: "production", dryRun: true }));
  assert.doesNotThrow(() => validateReleaseTarget({ track: "internal", dryRun: false }));
  const workflow = readFileSync(new URL("../../.github/workflows/ship-android-playstore-v1.yml", import.meta.url), "utf8");
  assert.match(workflow, /default: internal/);
  assert.match(workflow, /DRY_RUN: \$\{\{ inputs.dry_run \}\}/);
  assert.match(workflow, /\[ "\$TARGET_TRACK" = "production" \] && \[ "\$\{DRY_RUN:-false\}" != "true" \]/);
  assert.match(workflow, /Public Android upload is blocked/);
});
