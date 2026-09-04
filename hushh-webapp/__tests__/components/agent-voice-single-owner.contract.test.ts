import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("One interactive audio ownership", () => {
  it("delegates Agent Chat voice requests to the persistent One Live owner", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const agentBar = read("components/agent/agent-bar.tsx");

    expect(workspace).toContain("const startConversationalVoice = requestAgentConversation");
    expect(workspace).not.toContain("AgentVoiceClient");
    expect(workspace).not.toContain("AgentTtsQueue");
    expect(workspace).not.toContain("speechSynthesis");
    expect(workspace).not.toContain('owner: "agent_chat"');
    expect(workspace).not.toContain("/agent/voice/");

    expect(agentBar).toContain("AGENT_CONVERSATION_REQUEST_EVENT");
    expect(agentBar).toContain("handleConversationRequest");
    expect(agentBar).toContain("createRealtimeVoiceTransport");
    expect(agentBar).toContain('owner: "one_live"');
  });

  it("keeps removed chained STT and TTS modules out of the app contract", () => {
    expect(fs.existsSync(path.join(WEBAPP_ROOT, "lib/services/agent-voice-client.ts"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(WEBAPP_ROOT, "lib/agent/agent-voice-tts.ts"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(WEBAPP_ROOT, "lib/agent/agent-voice-turn.ts"))).toBe(
      false,
    );
  });
});
