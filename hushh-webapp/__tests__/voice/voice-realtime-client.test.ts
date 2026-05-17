import { describe, expect, it, vi } from "vitest";

import {
  VoiceRealtimeClient,
  buildEnglishOnlyRealtimeSpeechInstructions,
} from "@/lib/voice/voice-realtime-client";

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

  it("keeps realtime input transcription pinned to English in session updates", () => {
    const send = vi.fn();
    const client = new VoiceRealtimeClient() as unknown as {
      dataChannel: { readyState: string; send: (payload: string) => void };
      configureServerVAD: (input: {
        silenceDurationMs: number;
        disableAutoResponse: boolean;
        enableBargeIn: boolean;
        model: string;
        voice: string;
        transcriptionModel?: string;
        transcriptionLanguage?: string;
        transcriptionPrompt?: string;
      }) => void;
    };
    client.dataChannel = {
      readyState: "open",
      send,
    };

    client.configureServerVAD({
      silenceDurationMs: 1000,
      disableAutoResponse: true,
      enableBargeIn: false,
      model: "gpt-realtime",
      voice: "alloy",
      transcriptionModel: "gpt-4o-mini-transcribe",
      transcriptionLanguage: "en",
      transcriptionPrompt: "Transcribe spoken English only.",
    });

    const payload = JSON.parse(send.mock.calls[0]?.[0] || "{}");
    const input = payload.session.audio.input;
    expect(input.noise_reduction.type).toBe("near_field");
    expect(input.transcription).toEqual({
      model: "gpt-4o-mini-transcribe",
      language: "en",
      prompt: "Transcribe spoken English only.",
    });
    expect(input.turn_detection.create_response).toBe(false);
  });

  it("wraps realtime speech requests with English-only output instructions", () => {
    const instructions = buildEnglishOnlyRealtimeSpeechInstructions("Opening profile.");

    expect(instructions).toContain("Use English only");
    expect(instructions).toContain("Do not translate");
    expect(instructions).toContain("Opening profile.");
  });
});
