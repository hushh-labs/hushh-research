import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
  "utf8",
);

/**
 * agent-chat-workspace.tsx cannot be mounted in a unit test, so this guards the
 * wiring by source: a bare typed "yes"/"no" must be answered with a pointer to
 * the review card BEFORE any path that starts a turn or clears the card. The
 * classifier itself is covered in mcp-review-typed-reply.test.ts.
 */
describe("typed reply to a connector review card", () => {
  it("is intercepted before a turn can queue, join or clear the card", () => {
    const enqueue = source.slice(source.indexOf("const enqueuePrompt ="), source.indexOf("const enqueueReviewedDirective ="));
    expect(enqueue).toContain("interceptBareReviewReply(text)");
    expect(enqueue.indexOf("interceptBareReviewReply(text)")).toBeLessThan(enqueue.indexOf("enqueueWorkspaceOperation"));

    const turn = source.slice(source.indexOf("const runAgentTurn = async ("), source.indexOf("runAgentTurnRef.current = runAgentTurn"));
    expect(turn).toContain("interceptBareReviewReply(text)");
    expect(turn.indexOf("interceptBareReviewReply(text)")).toBeLessThan(turn.indexOf("setPendingMcpReviews([])"));
  });

  it("only points at the card and never approves or declines", () => {
    const handler = source.slice(
      source.indexOf("const interceptBareReviewReply ="),
      source.indexOf("const runAgentTurn = async ("),
    );
    expect(handler).toContain("Use Allow once or Cancel on the review card.");
    expect(handler).toContain("renderAsPlainAssistantMessage: true");
    expect(handler).not.toMatch(/resume|confirmMcpCall|setPendingMcpReviews/);
  });

  it("points at the card only while its buttons exist", () => {
    const handler = source.slice(
      source.indexOf("const interceptBareReviewReply ="),
      source.indexOf("const runAgentTurn = async ("),
    );
    // A loading, busy or dead card has nothing to point at: behave as before.
    expect(handler).toContain("actionableMcpReviewsRef.current.has(review.reference.directiveId)");
    expect(source).toContain("onActionableChange={(actionable) => {");
  });

  it("reads the live card from a ref, not a stale closure", () => {
    expect(source).toContain("pendingMcpReviewsRef.current = pendingMcpReviews;");
  });

  it("holds a new typed turn while an approved review is still being carried out", () => {
    // A new turn deletes the card and aborts the approved resume; the write can still
    // happen with no result shown, and a repeat request could duplicate it.
    const handler = source.slice(
      source.indexOf("const interceptBareReviewReply ="),
      source.indexOf("const runAgentTurn = async ("),
    );
    expect(source).toContain("decidingMcpReviewsRef");
    expect(handler.indexOf("decidingMcpReviewsRef.current.size > 0")).toBeGreaterThan(-1);
    expect(handler.indexOf("decidingMcpReviewsRef.current.size > 0")).toBeLessThan(
      handler.indexOf("pendingMcpReviewsRef.current[0]"),
    );
    expect(source).toContain("onDecidingChange={(deciding)");
  });
});
