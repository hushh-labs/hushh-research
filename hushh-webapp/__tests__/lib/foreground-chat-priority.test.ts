import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginForegroundChatPriority,
  isForegroundChatActive,
  resetForegroundChatPriorityForTests,
  subscribeForegroundChatPriority,
} from "@/lib/agent/foreground-chat-priority";

describe("foreground chat priority", () => {
  beforeEach(resetForegroundChatPriorityForTests);

  it("holds nested leases until the last turn settles", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeForegroundChatPriority(listener);
    const releaseFirst = beginForegroundChatPriority();
    const releaseSecond = beginForegroundChatPriority();
    expect(isForegroundChatActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    releaseFirst();
    expect(isForegroundChatActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    releaseSecond();
    expect(isForegroundChatActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("makes release idempotent", () => {
    const release = beginForegroundChatPriority();
    release();
    release();
    expect(isForegroundChatActive()).toBe(false);
  });
});
