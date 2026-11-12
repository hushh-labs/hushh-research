import fs from "node:fs";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(
  path.join(import.meta.dirname, "native-ui-test-runner-source.js"),
  "utf8",
);

test("native route navigation never treats a descendant as the requested route", () => {
  assert.doesNotMatch(source, /current\.indexOf\(expected \+ "\/"\)/);
  assert.match(source, /current\.indexOf\(expected \+ "\?"\) === 0/);
});
