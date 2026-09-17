import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("One interactive audio ownership", () => {
  it("delegates Agent Chat voice requests to the persistent command capture owner", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const provider = read("components/agent/location-command-provider.tsx");

    expect(workspace).toContain("const startConversationalVoice = requestAgentConversation");
    expect(workspace).not.toContain("AgentVoiceClient");
    expect(workspace).not.toContain("AgentTtsQueue");
    expect(workspace).not.toContain("speechSynthesis");
    expect(workspace).not.toContain('owner: "agent_chat"');
    expect(workspace).not.toContain("/agent/voice/");

    expect(provider).toContain("AGENT_CONVERSATION_REQUEST_EVENT");
    expect(provider).toContain("new CommandCapture()");
    expect(provider).toContain("new LocationCommandRuntime(");
    expect(provider).not.toContain("createRealtimeVoiceTransport");
    expect(provider).not.toContain("GeminiLiveClient");
    // The bounded owner yields conversation ownership when Live is on.
    expect(provider).toContain("function useCommandController(enabled = true)");
    expect(provider).toContain("if (!enabled) return;");
    expect(provider).not.toContain("OneLiveClient");
    expect(provider).not.toContain("one-voice/live-client");
  });

  it("mounts exactly one microphone owner at a time, switched by the server-owned readiness flag", () => {
    const gate = read("components/agent/agent-owner-gate.tsx");
    const providers = read("app/providers.tsx");
    const bar = read("components/agent/agent-bar.tsx");
    const live = read("components/one-voice/voice-session-provider.tsx");

    expect(gate).toContain("<LocationCommandProvider enabled={!live}>");
    expect(gate).toContain("<VoiceSessionProvider enabled={live}>");
    expect(gate).toContain("useOneVoiceLiveEnabled()");
    // The Live-only app bridges (the publish loop and the device Location
    // step consumer) mount together, once, and only while Live owns the mic;
    // the bounded owner keeps its own device bridge for the other case.
    expect(gate).toMatch(
      /live \? \(\s*<>\s*<LocationPublisherBridge \/>\s*<LocationUpdatesStepBridge \/>\s*<\/>\s*\)\s*:\s*null/,
    );
    expect(gate).toContain("{!live ? <LocationCommandDeviceBridge /> : null}");
    expect(gate.match(/<LocationUpdatesStepBridge \/>/g)).toHaveLength(1);
    expect(providers).toContain("<AgentOwnerGate>");
    expect(providers).not.toContain("<LocationCommandProvider>");
    expect(providers).toContain("<OneVoiceReadinessProvider>");

    // One stable launcher, two owners; never a NEXT_PUBLIC build flag.
    expect(bar).toContain("export function AgentBar");
    expect(bar).not.toContain("export { CommandAgentBar as AgentBar }");
    expect(bar).toContain("useOneVoiceLiveEnabled()");
    expect(bar).not.toContain("NEXT_PUBLIC_");

    // The Live owner never reaches for the bounded recorder or browser TTS.
    expect(live).not.toContain("new CommandCapture(");
    expect(live).not.toContain("LocationCommandRuntime");
    expect(live).not.toContain("speechSynthesis");
    expect(live).not.toContain("GeminiLiveClient");
  });

  it("keeps the explicit stop inside the same single-owner broker", () => {
    // A cancellation control must never take the release-and-submit request path.
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const settings = read("lib/agent/agent-voice-settings.ts");
    const provider = read("components/agent/location-command-provider.tsx");

    expect(settings).toContain("AGENT_CONVERSATION_STOP_EVENT");
    expect(settings).toContain("export function requestAgentConversationStop");
    expect(workspace).toContain(
      "const cancelConversationalVoice = requestAgentConversationStop",
    );
    expect(workspace).toContain("onCancel={cancelConversationalVoice}");
    expect(workspace).not.toContain("onCancel={startConversationalVoice}");
    expect(workspace).not.toContain("onToggleMute={startConversationalVoice}");
    expect(workspace).not.toContain("AgentVoiceClient");
    expect(provider).toContain("AGENT_CONVERSATION_STOP_EVENT");
    expect(provider).toContain("cancelCapture();");
    expect(provider).toContain("command.pause();");
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
