import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNativeArtifactSafe,
  sanitizeNativeArtifact,
  sanitizeRawStatusForReport,
} from "./native-report-sanitizer.mjs";

test("recursively redacts reviewer identity, DOM, errors, and tokens", () => {
  const canary = "private-canary-value";
  const sanitized = sanitizeNativeArtifact({
    route: "/one/pkm?token=private",
    bootstrap_uid: canary,
    bootstrap_uid_ok: "1",
    body: `private ${canary}`,
    nested: {
      id_token: canary,
      jsrej: canary,
      error: canary,
      errorClass: "timeout",
    },
  });
  assert.equal(sanitized.route, "/one/pkm");
  assert.equal(sanitized.bootstrap_uid, "<redacted>");
  assert.equal(sanitized.bootstrap_uid_ok, "1");
  assert.equal(sanitizeNativeArtifact({ bootstrap_uid_ok: "0" }).bootstrap_uid_ok, "0");
  assert.equal(sanitizeNativeArtifact({ bootstrap_uid_ok: canary }).bootstrap_uid_ok, "<redacted>");
  assert.equal(sanitized.body, "<redacted>");
  assert.equal(sanitized.nested.id_token, "<redacted>");
  assert.equal(sanitized.nested.jsrej, "<redacted>");
  assert.equal(sanitized.nested.error, "<redacted>");
  assert.equal(sanitized.nested.errorClass, "timeout");
  assertNativeArtifactSafe(sanitized, [canary]);
});

test("sanitizes semicolon status before persistence", () => {
  const sanitized = sanitizeRawStatusForReport(
    "route=/one/pkm?code=private;bootstrap_uid=private;jsrej=private;long_wait=1",
  );
  assert.match(sanitized, /route=\/one\/pkm(?:;|$)/);
  assert.match(sanitized, /bootstrap_uid=<redacted>/);
  assert.match(sanitized, /jsrej=<redacted>/);
  assert.doesNotMatch(sanitized, /code=private/);
});
