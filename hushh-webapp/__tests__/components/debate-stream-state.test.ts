import { describe, expect, it } from "vitest";

import { getInitialRoundCollapseState } from "@/components/kai/debate-stream-state";

describe("debate-stream-state", () => {
  describe("getInitialRoundCollapseState", () => {
    it("preserves round 1 expanded and round 2 collapsed by default", () => {
      expect(getInitialRoundCollapseState()).toEqual({
        1: false,
        2: true,
      });
    });

    it("preserves a fresh object on each call", () => {
      expect(getInitialRoundCollapseState()).not.toBe(
        getInitialRoundCollapseState(),
      );
    });
  });
});