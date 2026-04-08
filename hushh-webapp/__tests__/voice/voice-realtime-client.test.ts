import { describe, expect, it, vi } from "vitest";

import { VoiceRealtimeClient } from "@/lib/voice/voice-realtime-client";

describe("voice-realtime-client", () => {
  it("does not send response.cancel when there is no active pending speech", () => {
    const client = new VoiceRealtimeClient() as unknown as {
      dataChannel: { readyState: string; send: (payload: string) => void };
      pendingSpeech: null;
      cancelSpeech: (reason?: string) => void;
    };
    client.dataChannel = {
      readyState: "open",
      send: vi.fn(),
    };
    client.pendingSpeech = null;

    client.cancelSpeech("VOICE_STREAM_TTS_CANCELLED");

    expect(client.dataChannel.send).not.toHaveBeenCalled();
  });

  it("does not send response.cancel after the pending response is already done", () => {
    const reject = vi.fn();
    const client = new VoiceRealtimeClient() as unknown as {
      dataChannel: { readyState: string; send: (payload: string) => void };
      pendingSpeech: {
        timeoutHandle: number;
        responseDone: boolean;
        reject: (error: Error) => void;
      } | null;
      cancelSpeech: (reason?: string) => void;
    };
    client.dataChannel = {
      readyState: "open",
      send: vi.fn(),
    };
    client.pendingSpeech = {
      timeoutHandle: window.setTimeout(() => undefined, 1000),
      responseDone: true,
      reject,
    };

    client.cancelSpeech("VOICE_STREAM_TTS_CANCELLED");

    expect(client.dataChannel.send).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(expect.any(Error));
  });

  it("drops unsolicited response.done events without sending a late cancel", () => {
    const client = new VoiceRealtimeClient() as unknown as {
      dataChannel: { readyState: string; send: (payload: string) => void };
      pendingSpeech: null;
      onDebug?: (event: string, payload?: Record<string, unknown>) => void;
      maybeDropUnsolicitedAssistantEvent: (payload: Record<string, unknown>) => boolean;
    };
    client.dataChannel = {
      readyState: "open",
      send: vi.fn(),
    };
    client.pendingSpeech = null;
    client.onDebug = vi.fn();

    const dropped = client.maybeDropUnsolicitedAssistantEvent({
      type: "response.done",
      response_id: "vrsp_1",
    });

    expect(dropped).toBe(true);
    expect(client.dataChannel.send).not.toHaveBeenCalled();
  });
});
