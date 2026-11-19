import { describe, expect, it } from "vitest";
import { canRetryFinanceResult, isCurrentFinanceResultScope } from "@/lib/agent/finance-result-scope";

describe("selected Finance result authority", () => {
  const scope = { ownerId: "owner", conversationId: "chat", vaultEpoch: 1, chatEpoch: 2, messageId: "card" };
  it("accepts the originating live card and rejects changed authority or a stale card", () => {
    expect(isCurrentFinanceResultScope(scope, scope)).toBe(true);
    for (const change of [
      { ownerId: "other" }, { ownerId: null }, { conversationId: "other" },
      { vaultEpoch: 2 }, { chatEpoch: 3 }, { messageId: "later" },
    ]) expect(isCurrentFinanceResultScope(scope, { ...scope, ...change })).toBe(false);
  });
  it("retries only confirmed unexecuted requests with the same owner's complete in-memory result", () => {
    const task = { userId: "owner", status: "completed", completedAt: "2026-11-19", finalDecision: { finalStatement: "Result" } };
    expect(canRetryFinanceResult(true, "owner", task)).toBe(true);
    expect(canRetryFinanceResult(false, "owner", task)).toBe(false);
    expect(canRetryFinanceResult(true, "other", task)).toBe(false);
    expect(canRetryFinanceResult(true, "owner", { ...task, status: "running" })).toBe(false);
    expect(canRetryFinanceResult(true, "owner", { ...task, finalDecision: null })).toBe(false);
    expect(canRetryFinanceResult(true, "owner", null)).toBe(false);
  });
});
