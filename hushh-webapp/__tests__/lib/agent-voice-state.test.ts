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
    expect(useAgentVoiceState.getState().oneVoiceState).toBe("listening");

    useAgentVoiceState.getState().setStatus("transcribing");
    useAgentVoiceState.getState().setLevel(2);

    expect(useAgentVoiceState.getState().status).toBe("transcribing");
    expect(useAgentVoiceState.getState().oneVoiceState).toBe("understanding");
    expect(useAgentVoiceState.getState().transitionSeq).toBeGreaterThan(0);
    expect(useAgentVoiceState.getState().level).toBe(1);
    expect(useAgentVoiceState.getState().lastTransition).toMatchObject({
      from: "listening",
      to: "understanding",
      ariaLive: "polite",
    });

    useAgentVoiceState.getState().reset();

    expect(useAgentVoiceState.getState().active).toBe(false);
    expect(useAgentVoiceState.getState().status).toBe("idle");
    expect(useAgentVoiceState.getState().oneVoiceState).toBe("idle");
  });

  it("ignores stale provider events from an older session or source sequence", () => {
    useAgentVoiceState.getState().setActive(true, {
      sessionId: "session_new",
      sourceId: "gemini",
      sourceSeq: 1,
    });
    useAgentVoiceState.getState().setStatus("listening", null, {
      sessionId: "session_new",
      sourceId: "gemini",
      sourceSeq: 2,
    });
    const acceptedSeq = useAgentVoiceState.getState().transitionSeq;

    useAgentVoiceState.getState().setStatus("speaking", "late old session", {
      sessionId: "session_old",
      sourceId: "gemini",
      sourceSeq: 3,
    });
    expect(useAgentVoiceState.getState().status).toBe("listening");
    expect(useAgentVoiceState.getState().transitionSeq).toBe(acceptedSeq);

    useAgentVoiceState.getState().setStatus("thinking", "late old event", {
      sessionId: "session_new",
      sourceId: "gemini",
      sourceSeq: 1,
    });
    expect(useAgentVoiceState.getState().status).toBe("listening");
    expect(useAgentVoiceState.getState().transitionSeq).toBe(acceptedSeq);

    useAgentVoiceState.getState().setStatus("speaking", "new event", {
      sessionId: "session_new",
      sourceId: "gemini",
      sourceSeq: 4,
    });
    expect(useAgentVoiceState.getState().status).toBe("speaking");
    expect(useAgentVoiceState.getState().lastTransition).toMatchObject({
      sessionId: "session_new",
      sourceId: "gemini",
    });
  });

  it("formats compact status labels", () => {
    expect(getAgentVoiceStatusLabel("listening")).toBe("Listening");
    expect(getAgentVoiceStatusLabel("muted")).toBe("Muted");
    expect(getAgentVoiceStatusLabel("transcribing")).toBe("Transcribing");
    expect(getAgentVoiceStatusLabel("thinking")).toBe("Thinking");
    expect(getAgentVoiceStatusLabel("speaking")).toBe("Speaking");
  });
});
