import { describe, expect, it, vi } from "vitest";

import { GeminiLiveTransport } from "@/lib/services/gemini-live-client";
import { OpenAIRealtimeTransport } from "@/lib/voice/openai-realtime-transport";
import { createRealtimeVoiceTransport } from "@/lib/voice/one-voice-transport-factory";

describe("One Voice realtime transports", () => {
  it("exposes Gemini Live as the active provider-neutral transport", () => {
    const transport = new GeminiLiveTransport();

    expect(transport.provider).toBe("gemini_live");
    expect(typeof transport.start).toBe("function");
    expect(typeof transport.stop).toBe("function");
  });

  it("creates transports through the provider-neutral factory", () => {
    expect(createRealtimeVoiceTransport().provider).toBe("gemini_live");
    expect(createRealtimeVoiceTransport({}, "openai_realtime").provider).toBe(
      "openai_realtime"
    );
  });

  it("emits Gemini state events with session and source sequence metadata", () => {
    const onEvent = vi.fn();
    const onVoiceState = vi.fn();
    const transport = new GeminiLiveTransport({ onEvent, onVoiceState });
    const testTransport = transport as unknown as {
      sessionId: string | null;
      setState: (state: "connecting") => void;
    };

    testTransport.sessionId = "gemini_session_1";
    testTransport.setState("connecting");

    expect(onVoiceState).toHaveBeenCalledWith("connecting", {
      sessionId: "gemini_session_1",
      sourceId: "gemini_live",
      sourceSeq: 1,
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state",
        provider: "gemini_live",
        sessionId: "gemini_session_1",
        sourceId: "gemini_live",
        sourceSeq: 1,
      })
    );
  });

  it("keeps OpenAI Realtime behind the same interface until enabled", async () => {
    const onEvent = vi.fn();
    const transport = new OpenAIRealtimeTransport({ onEvent });

    await expect(transport.start()).rejects.toThrow("OpenAI Realtime is scaffolded");
    expect(transport.provider).toBe("openai_realtime");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        provider: "openai_realtime",
      })
    );

    transport.stop();
    expect(onEvent).toHaveBeenCalledWith({
      type: "closed",
      provider: "openai_realtime",
    });
  });
});
