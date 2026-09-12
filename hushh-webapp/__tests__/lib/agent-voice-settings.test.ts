import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isAgentCommandEnabled,
} from "@/lib/agent/agent-voice-settings";

describe("agent voice settings", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats Talk to One commands as enabled unless explicitly disabled", () => {
    expect(isAgentCommandEnabled()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_AGENT_COMMAND_ENABLED", "false");
    expect(isAgentCommandEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_AGENT_COMMAND_ENABLED", "1");
    expect(isAgentCommandEnabled()).toBe(true);
  });

});
