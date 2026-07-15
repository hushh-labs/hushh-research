import { beforeEach, describe, expect, it } from "vitest";

import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

describe("OneSetupCompletionHintService", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists only a positive user-scoped completion signal", () => {
    expect(OneSetupCompletionHintService.isResolved("user-a")).toBe(false);

    OneSetupCompletionHintService.markResolved("user-a");

    expect(OneSetupCompletionHintService.isResolved("user-a")).toBe(true);
    expect(OneSetupCompletionHintService.isResolved("user-b")).toBe(false);
    expect(Object.keys(window.localStorage)).toEqual([
      "hushh.one_setup_complete.v1.user-a",
    ]);
    expect(window.localStorage.getItem(Object.keys(window.localStorage)[0]!)).toBe(
      "1",
    );
  });

  it("clears the completion signal without affecting another user", () => {
    OneSetupCompletionHintService.markResolved("user-a");
    OneSetupCompletionHintService.markResolved("user-b");

    OneSetupCompletionHintService.clear("user-a");

    expect(OneSetupCompletionHintService.isResolved("user-a")).toBe(false);
    expect(OneSetupCompletionHintService.isResolved("user-b")).toBe(true);
  });
});
