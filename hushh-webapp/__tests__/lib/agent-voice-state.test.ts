import { beforeEach, describe, expect, it } from "vitest";

import {
  getAgentVoiceStatusLabel,
  useAgentVoiceState,
} from "@/lib/agent/agent-voice-state";

describe("agent voice state", () => {
  beforeEach(() => {
    useAgentVoiceState.getState().reset();
  });

  it("tracks active voice status for the floating indicator", () => {
    useAgentVoiceState.getState().setActive(true);
    expect(useAgentVoiceState.getState().active).toBe(true);
    expect(useAgentVoiceState.getState().status).toBe("listening");

    useAgentVoiceState.getState().setStatus("transcribing");
    useAgentVoiceState.getState().setLevel(2);

    expect(useAgentVoiceState.getState().status).toBe("transcribing");
    expect(useAgentVoiceState.getState().level).toBe(1);

    useAgentVoiceState.getState().reset();

    expect(useAgentVoiceState.getState().active).toBe(false);
    expect(useAgentVoiceState.getState().status).toBe("idle");
  });

  it("formats compact status labels", () => {
    expect(getAgentVoiceStatusLabel("listening")).toBe("Listening");
    expect(getAgentVoiceStatusLabel("muted")).toBe("Muted");
    expect(getAgentVoiceStatusLabel("transcribing")).toBe("Transcribing");
    expect(getAgentVoiceStatusLabel("thinking")).toBe("Thinking");
    expect(getAgentVoiceStatusLabel("speaking")).toBe("Speaking");
  });
});
