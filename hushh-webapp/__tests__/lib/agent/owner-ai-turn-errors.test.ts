/**
 * A private agent with the person's own AI key never falls back to managed
 * models, so a refused or exhausted key ends the turn with a typed code. The
 * transcript must say what happened and link to the screen that fixes it,
 * without ever echoing server text.
 */
import { describe, expect, it, vi } from "vitest";

import { ROUTES } from "@/lib/navigation/routes";
import { formatAgentChatErrorMessage } from "@/lib/services/agent-chat-client";

vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));

const LINK = `(${ROUTES.PROFILE_PREFERENCES_GEMINI})`;

describe("own-key turn errors (C4)", () => {
  it("turns a chat-key refusal into recoverable copy, never raw server text", () => {
    expect(formatAgentChatErrorMessage("anything", "CHAT_KEY_REQUIRED")).toMatch(/^Unlock your vault, then try again/);
    expect(formatAgentChatErrorMessage('HTTP 403: {"detail":{"code":"CHAT_KEY_REQUIRED"}}'))
      .toMatch(/update or refresh the app/);
    expect(formatAgentChatErrorMessage("x", "CHAT_KEY_MISMATCH")).toMatch(/did not open with this vault/);
    expect(formatAgentChatErrorMessage("x", "CHAT_CONVERSATION_RETIRED")).toMatch(/Start a new chat/);
  });

  it("names the provider and links to Bring your own AI", () => {
    const refused = formatAgentChatErrorMessage("provider=openai status=401", "OWNER_AI_KEY_REFUSED");
    expect(refused).toBe(`OpenAI did not accept your key. [Check it in Bring your own AI]${LINK}.`);
    const quota = formatAgentChatErrorMessage("gemini quota", "OWNER_AI_QUOTA_EXCEEDED");
    expect(quota).toBe(`Your Gemini key is out of quota. Check your account with the provider, or [change it in Bring your own AI]${LINK}.`);
  });

  it("never echoes server text, even when the provider is not recognised", () => {
    const visible = formatAgentChatErrorMessage("upstream said: sk-leaked-secret user=owner-1", "OWNER_AI_KEY_REFUSED");
    expect(visible).toBe(`Your AI provider did not accept your key. [Check it in Bring your own AI]${LINK}.`);
    expect(visible).not.toContain("sk-leaked-secret");
  });
});


describe("chat recovery errors", () => {
  it("never exposes unknown AG-UI runtime errors to the transcript", () => {
    const raw =
      'DB operation failed [<raw_sql>.execute_raw]: INSERT INTO one_adk_sessions [parameters: {"user":"owner-1","ciphertext":"secret"}]';

    const visible = formatAgentChatErrorMessage(raw);

    expect(visible).toBe("One couldn't complete that response. Please try again.");
    expect(visible).not.toContain("one_adk_sessions");
    expect(visible).not.toContain("owner-1");
    expect(visible).not.toContain("ciphertext");
  });

  it("maps typed database failures to stable actionable copy", () => {
    expect(
      formatAgentChatErrorMessage("private database detail", "DATABASE_EXECUTION_ERROR"),
    ).toBe("One's conversation history is temporarily unavailable. Please try again.");
  });

  it("maps untyped provider capacity failures without exposing runtime details", () => {
    const visible = formatAgentChatErrorMessage(
      "429 Too Many Requests: RESOURCE_EXHAUSTED",
    );

    expect(visible).toBe("One is temporarily at capacity. Please try again in a moment.");
    expect(visible).not.toContain("RESOURCE_EXHAUSTED");
    expect(visible).not.toContain("429");
  });

  // The server authors these (hushh_mcp/one_adk/run_errors.py) for the person;
  // they used to fall through to the generic line because only text was read.
  it("shows the server's authored retryable errors by code, never by message text", () => {
    expect(formatAgentChatErrorMessage("One is temporarily at capacity. Please try again in a moment.", "RESOURCE_EXHAUSTED"))
      .toBe("One is temporarily at capacity. Please try again in a moment.");
    expect(formatAgentChatErrorMessage("anything", "MODEL_UNAVAILABLE"))
      .toBe("One's model service was briefly unavailable. Please try again.");
    expect(formatAgentChatErrorMessage("anything", "SERVER_RESTARTING"))
      .toBe("One was interrupted because the service restarted. Please send that again.");
    // Negative control: the same text under another code is not trusted.
    expect(formatAgentChatErrorMessage("One's model service was briefly unavailable. Please try again.", "MODEL_ERROR"))
      .toBe("One couldn't complete that response. Please try again.");
  });

});
