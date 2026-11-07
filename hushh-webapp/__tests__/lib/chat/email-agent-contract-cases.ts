import { expect, it, vi, type Mock } from "vitest";
import { parseGmailReviewDirective, streamAgentChat, streamAgentIntro, type AgentChatStreamHandlers } from "@/lib/services/agent-chat-client";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

type TransportHarness = {
  runAgent: Mock;
  outcome: "success" | "interrupt";
  emitEvents: null | ((subscriber: Record<string, (input: any) => void>) => void);
};
const TEST_VAULT_KEY = "0f".repeat(32);

/** Registers only Email contracts against the parent suite's actual transport fake. */
export function registerEmailAgentContractCases(mockTransport: TransportHarness): void {
  registerEmailCapabilityCase(mockTransport);
  it("admits prepared Email reviews without approval and preserves mailbox proposals", async () => {
    publishValidatedAuthSessionOwner("user-1");
    const review = { type: "gmail.review_requested", operation: "reply_to_thread", draft: {
      to: "reply@example.com", cc: "", bcc: "", subject: "Re: Planning", body: "Friday works.",
      sourceMailRef: "rs1.nX4-qL9_c2VhbGVkLXJlcGx5LXNvdXJjZQ" } };
    expect(parseGmailReviewDirective(review)).toEqual(review);
    for (const invalid of [{ ...review, approved: true }, { ...review, draft: { ...review.draft, cc: "extra@example.com" } },
      { ...review, draft: { ...review.draft, sourceMailRef: "provider-thread-id" } },
      { ...review, draft: { ...review.draft, body: "x".repeat(12001) } },
      { ...review, draft: { ...review.draft, threadId: "not-an-authority" } },
      { ...review, operation: "send_email" }]) expect(parseGmailReviewDirective(invalid)).toBeNull();
    const compose = { type: "gmail.review_requested", operation: "send_email", draft: {
      to: "to@example.com", cc: "cc@example.com", bcc: "bcc@example.com", subject: "Planning", body: "Complete body." } };
    expect(parseGmailReviewDirective(compose)).toEqual(compose);
    const mailbox = { type: "gmail.execute_mailbox_proposal", proposalId: "proposal-1", action: "archive", label: "Archive",
      summary: "Archive selected mail", confirmLabel: "Archive", expiresAt: "2026-11-03T00:00:00Z", messages: [], truncated: false };
    const revised = { ...review, draft: { ...review.draft, body: "Friday at noon works." } };
    mockTransport.emitEvents = subscriber => {
      for (const [delegateAgentId, payload] of [["agent_email", review], ["agent_nav", review],
        ["agent_email", { ...review, approved: true }], ["agent_email", revised], ["agent_email", mailbox]] as const) {
        subscriber.onStateDeltaEvent?.({ event: { type: "STATE_DELTA", delta: [{ op: "add",
          path: "/hussh:pending_directive:gmail", value: { delegateAgentId, kind: "action", payload } }] } });
      }
    };
    const staged = vi.fn();
    await streamAgentChat({ vaultKey: TEST_VAULT_KEY, userId: "user-1", message: "Reply Friday works",
      vaultOwnerToken: "owner-token", handlers: { onSpecialistDirective: staged } });
    expect(staged).toHaveBeenCalledTimes(3);
    expect(staged.mock.calls[0][0]).toMatchObject({ delegateAgentId: "agent_email", stateChanged: false, directive: { payload: review } });
    expect(staged.mock.calls[1][0].directive.payload).toEqual(revised);
    expect(staged.mock.calls[1][0].directive.payload.draft.sourceMailRef).toBe(review.draft.sourceMailRef);
    expect(staged.mock.calls[2][0].directive.payload).toEqual(mailbox);
  });
  it("keeps an Email memory save pending for review and sends only the confirmed commit locator", async () => {
    publishValidatedAuthSessionOwner("user-1");
    const directive = { kind: "email_memory_save", owner_id: "user-1",
      request_id: "d2b51581-90a1-497c-ae12-ef195b6cf8f1", domain_tag: "preferences",
      fact_markdown: "Use short replies.", section: "Preferences", digest: "a".repeat(64) };
    mockTransport.emitEvents = subscriber => {
      for (const [delegateAgentId, payload] of [["agent_email", directive],
        ["agent_nav", directive], ["agent_email", { ...directive, section: "Secrets" }]] as const) {
        subscriber.onStateDeltaEvent?.({ event: { type: "STATE_DELTA", delta: [{ op: "add",
          path: "/hussh:pending_directive:email_memory", value: { delegateAgentId, kind: "action", payload } }] } });
      }
    };
    const staged = vi.fn();
    const projection = { source: "one_memory.markdown" as const, owner_id: "user-1",
      markdown: "## Preferences\n- Use short replies.", budget_chars: 18000, revision: 4 };
    const receipt = { status: "committed" as const, saved: true as const, request_id: directive.request_id,
      digest: directive.digest, receipt_ref: `pkm_plan_${"b".repeat(32)}`, revision: 5, saved_count: 1 };
    mockTransport.runAgent.mockClear();
    await streamAgentChat({ vaultKey: TEST_VAULT_KEY, userId: "user-1", message: "Remember my preference",
      vaultOwnerToken: "owner-token", emailMemoryProjection: projection, emailMemoryCommit: receipt,
      handlers: { onSpecialistDirective: staged } });
    expect(staged).toHaveBeenCalledTimes(1);
    expect(staged).toHaveBeenCalledWith(expect.objectContaining({ stateChanged: false,
      directive: { kind: "action", payload: directive } }));
    const forwarded = mockTransport.runAgent.mock.calls[0][0].forwardedProps;
    expect(forwarded.emailMemoryProjection).toEqual(projection);
    expect(forwarded.emailMemoryCommit).toEqual({ request_id: receipt.request_id, digest: receipt.digest,
      receipt_ref: receipt.receipt_ref, revision: 5, saved_count: 1 });
    expect(forwarded.emailMemoryCommit).not.toHaveProperty("saved");
  });
}

function registerEmailCapabilityCase(mockTransport: TransportHarness): void {
  it("advertises Email contract support on initial, intro and resumed turns", async () => {
    publishValidatedAuthSessionOwner("user-1");
    mockTransport.runAgent.mockClear();
    const reference = { kind: "mcp_call_review", version: 1,
      connectorId: "custom_test", toolName: `mcp_${"a".repeat(40)}`,
      directiveId: `dir_${"b".repeat(32)}`, pendingHandle: `one_secret_ref:${"c".repeat(32)}`,
      expiresAt: "2099-01-01T00:00:00Z" };
    const onMcpReview = vi.fn<NonNullable<AgentChatStreamHandlers["onMcpReview"]>>();
    mockTransport.outcome = "interrupt";
    mockTransport.emitEvents = subscriber => subscriber.onToolCallEndEvent?.({
      event: { type: "TOOL_CALL_END", toolCallId: "tool-1" }, toolCallName: "adk_request_confirmation",
      toolCallArgs: { originalFunctionCall: { id: "original", name: reference.toolName, args: {} },
        toolConfirmation: { confirmed: false, payload: reference } },
    });
    try {
      await streamAgentChat({ vaultKey: TEST_VAULT_KEY, userId: "user-1", message: "Use connector",
        conversationId: "email-contract", vaultOwnerToken: "owner-token", handlers: { onMcpReview } });
      expect(onMcpReview).toHaveBeenCalledOnce();
      mockTransport.outcome = "success";
      mockTransport.emitEvents = null;
      await onMcpReview.mock.calls[0][0].resume(null);
      await streamAgentIntro({ message: "Hello" });
      expect(mockTransport.runAgent.mock.calls.map(([parameters]) => parameters.forwardedProps.emailAgentContract))
        .toEqual([1, 1, 1]);
    } finally {
      mockTransport.outcome = "success";
      mockTransport.emitEvents = null;
    }
  });
}
