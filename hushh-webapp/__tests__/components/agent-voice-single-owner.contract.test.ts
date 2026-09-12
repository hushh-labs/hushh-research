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

  it("keeps the explicit stop inside the same single-owner broker", () => {
    // Ending a live session is a different verb from requesting one: the
    // request path is a TOGGLE, so calling it to stop would START a cloud
    // session when none was running, and it no-ops during the window where
    // the microphone lease is held but the transport is not live yet. The
    // workspace still owns no audio; it dispatches, and the bar stops.
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const settings = read("lib/agent/agent-voice-settings.ts");
    const agentBar = read("components/agent/agent-bar.tsx");

    expect(settings).toContain("AGENT_CONVERSATION_STOP_EVENT");
    expect(settings).toContain("export function requestAgentConversationStop");
    expect(workspace).toContain("requestAgentConversationStop();");
    expect(workspace).not.toContain("AgentVoiceClient");
    expect(agentBar).toContain("AGENT_CONVERSATION_STOP_EVENT");
    // Guarded, so it can never become a general-purpose cancel: the same
    // `stopConversation` also aborts an in-flight typed action run.
    expect(agentBar).toContain("!voiceLeaseRef.current &&");
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
