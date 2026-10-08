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
