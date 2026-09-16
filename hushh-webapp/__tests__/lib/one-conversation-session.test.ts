import { beforeEach, describe, expect, it } from "vitest";

import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

describe("One conversation session entry welcome", () => {
  beforeEach(() => {
    useOneConversationSession.getState().clearSession();
  });

  it("queues and consumes a post-setup marker without persisting personal content", () => {
    useOneConversationSession.getState().queueEntryWelcome("owner-a");

    expect(useOneConversationSession.getState().pendingEntryWelcome).toEqual({
      userId: "owner-a",
      kind: "post_setup",
    });

    useOneConversationSession.getState().consumeEntryWelcome("owner-a");
    expect(useOneConversationSession.getState().pendingEntryWelcome).toBeNull();
  });

  it("does not let one owner consume another owner's marker", () => {
    useOneConversationSession.getState().queueEntryWelcome("owner-a");

    useOneConversationSession.getState().consumeEntryWelcome("owner-b");
    expect(useOneConversationSession.getState().pendingEntryWelcome?.userId).toBe(
      "owner-a",
    );
  });

  it("clears the marker at the session boundary", () => {
    useOneConversationSession.getState().queueEntryWelcome("owner-a");
    useOneConversationSession.getState().clearSession();

    expect(useOneConversationSession.getState().pendingEntryWelcome).toBeNull();
  });
});
