/**
 * A turn that never reached the person's own agent ends with words that say
 * what happened. Live 2026-10-06: a stale endpoint pin threw
 * POD_ASSIGNMENT_CHANGED and the transcript only said "One couldn't complete
 * that response. Please try again.", which Try again could never fix.
 */
import { describe, expect, it, vi } from "vitest";

import { formatAgentChatErrorMessage } from "@/lib/services/agent-chat-client";

vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));

const GENERIC = "One couldn't complete that response. Please try again.";

describe("direct-path turn errors", () => {
  it("names a moved agent, a wake that timed out, and an agent that could not be reached", () => {
    expect(formatAgentChatErrorMessage("POD_ASSIGNMENT_CHANGED")).toMatch(/^Your private agent moved/);
    expect(formatAgentChatErrorMessage("x", "POD_ASSIGNMENT_CHANGED")).toMatch(/Open Hosting in Settings/);
    expect(formatAgentChatErrorMessage("POD_CHAT_AUTHORITY_UNAVAILABLE:409")).toMatch(/^Your private agent moved/);
    expect(formatAgentChatErrorMessage("POD_WAKE_TIMEOUT", "POD_WAKE_TIMEOUT"))
      .toBe("Your private agent did not wake up in time, so your message was not sent. Try again in a minute.");
    expect(formatAgentChatErrorMessage("POD_NOT_REACHED", "POD_NOT_REACHED")).toMatch(/could not be reached, so your message was not sent/);
    expect(formatAgentChatErrorMessage("POD_CHAT_AUTHORITY_UNAVAILABLE:403")).toMatch(/^Hussh could not confirm this chat/);
    expect(formatAgentChatErrorMessage("Failed to fetch")).toBe("One could not be reached. Check your internet connection, then try again.");
    expect(formatAgentChatErrorMessage("Load failed")).toMatch(/^One could not be reached/);
  });

  it("keeps the earlier direct-path copy and never echoes unknown text", () => {
    expect(formatAgentChatErrorMessage("ENDPOINT_UNAVAILABLE:POD_DIRECT_NOT_READY")).toMatch(/connection is not ready/);
    expect(formatAgentChatErrorMessage("POD_CHALLENGE_REFUSED:revoked")).toMatch(/could not be established/);
    expect(formatAgentChatErrorMessage("ENDPOINT_VERSION_REGRESSION")).toMatch(/could not be established/);
    expect(formatAgentChatErrorMessage("x", "POD_CHAT_BUSY")).toMatch(/finishing active work/);
    // Negative controls: a marker inside other text, or unknown text, stays generic.
    expect(formatAgentChatErrorMessage("detail POD_ASSIGNMENT_CHANGED at 10.0.0.1")).toBe(GENERIC);
    expect(formatAgentChatErrorMessage("Failed to fetch https://private.example/x")).toBe(GENERIC);
    for (const text of ["POD_ASSIGNMENT_CHANGED", "POD_WAKE_TIMEOUT", "Failed to fetch"]) {
      expect(formatAgentChatErrorMessage(text)).not.toContain(text);
    }
  });

  it("uses calm copy without dashes", () => {
    for (const text of ["POD_ASSIGNMENT_CHANGED", "POD_WAKE_TIMEOUT", "POD_NOT_REACHED", "Failed to fetch", "POD_OWNER_CHANGED"]) {
      expect(formatAgentChatErrorMessage(text)).not.toMatch(/[–—]/);
    }
  });
});
