import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useOneConversationSession, useOneComposerDraft } from "@/lib/agent/one-conversation-session";
import { createPendingTextAttachment } from "@/lib/agent/large-text-attachment";

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

  it("preserves one authoritative draft and editor purpose across a Chat route remount", () => {
    const first = renderHook(() => useOneComposerDraft(true, "owner-a"));
    const context = first.result.current.context;
    const attachment = createPendingTextAttachment("Synthetic attachment", true);
    act(() => {
      first.result.current.setInput("Synthetic 👋\nSecond line");
      first.result.current.setAttachment(attachment);
      first.result.current.setExpanded(true);
    });
    first.unmount();
    const returning = renderHook(() => useOneComposerDraft(true, "owner-a"));
    expect(returning.result.current.ready).toBe(true);
    expect(returning.result.current.context).toBe(context);
    expect(returning.result.current.input).toBe("Synthetic 👋\nSecond line");
    expect(returning.result.current.attachment).toEqual(attachment);
    expect(returning.result.current.expanded).toBe(true);
    returning.unmount();
  });

  it("erases a departed owner and refuses stale callbacks after withdrawal or session clear", () => {
    const view = renderHook(({ owner }) => useOneComposerDraft(true, owner), { initialProps: { owner: "owner-a" as string | null } });
    const stale = view.result.current.setInput;
    act(() => stale("Synthetic old draft"));
    view.rerender({ owner: null });
    expect(useOneConversationSession.getState().composerDraft).toBeNull();
    expect(view.result.current.input).toBe("");
    view.rerender({ owner: "owner-b" });
    act(() => { stale("Late response"); view.result.current.setInput("Synthetic new draft"); });
    expect(view.result.current.input).toBe("Synthetic new draft");
    const replaced = view.result.current.setInput;
    act(() => useOneConversationSession.getState().clearSession());
    act(() => replaced("Late response"));
    expect(useOneConversationSession.getState().composerDraft).toBeNull();
    view.unmount();
  });
});
