import { describe, expect, it } from "vitest";

import {
  KNOWN_EXECUTION_TARGET_PATHS,
  normalizeExecutionTarget,
} from "../../scripts/voice/generate-kai-action-gateway.mjs";

/**
 * #6122: two real, contract-authored actions (location.find_contacts,
 * ria.clients.switch_to_nearby) had execution_target.path: "control", which
 * was not in the frontend gateway parser's accepted union
 * (lib/voice/kai-action-gateway.ts's validateExecutionTarget) -- so the
 * generator happily wrote them into the compiled JSON, and the frontend
 * silently dropped both actions entirely, everywhere, with no error. The
 * generator had no path validation of its own to have caught this at
 * authoring time. These tests pin that it now does.
 */
describe("normalizeExecutionTarget rejects an unrecognized wired path", () => {
  it("accepts every path the frontend gateway parser also accepts", () => {
    for (const path of KNOWN_EXECUTION_TARGET_PATHS) {
      expect(() =>
        normalizeExecutionTarget(
          { status: "wired", path, target: "some.target" },
          "test.action",
        ),
      ).not.toThrow();
    }
  });

  it("throws on a path that isn't in the known set, naming the offending action", () => {
    expect(() =>
      normalizeExecutionTarget(
        { status: "wired", path: "typo_path", target: "some.target" },
        "test.action",
      ),
    ).toThrow(/test\.action.*typo_path/s);
  });

  it("still requires target for a recognized path", () => {
    expect(() =>
      normalizeExecutionTarget(
        { status: "wired", path: "local_handler" },
        "test.action",
      ),
    ).toThrow(/requires path and target/);
  });
});
