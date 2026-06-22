import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    transcribeAgentVoice: vi.fn(),
  },
}));

import {
  AgentVoiceClient,
  getAgentVoiceEndSilenceThresholdMs,
  getAgentVoiceStartErrorMessage,
  shouldConfirmAgentVoiceTranscript,
  transcribeAgentVoice,
} from "@/lib/services/agent-voice-client";
import { ApiService } from "@/lib/services/api-service";

describe("agent voice client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts audio to the Agent voice STT route through ApiService", async () => {
    vi.spyOn(ApiService, "transcribeAgentVoice").mockResolvedValue(
      new Response(
        JSON.stringify({
          transcript: "start Nvidia analysis",
          uncertain: false,
          reason: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const audio = new Blob(["fake-audio"], { type: "audio/webm" });

    const result = await transcribeAgentVoice({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      audio,
    });

    expect(result).toEqual({
      transcript: "start Nvidia analysis",
      uncertain: false,
      reason: null,
    });
    expect(ApiService.transcribeAgentVoice).toHaveBeenCalledWith({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      audio,
      filename: "agent-voice-utterance.webm",
      signal: expect.any(AbortSignal),
    });
  });

  it("marks uncertain or empty transcripts as needing confirmation", () => {
    expect(
      shouldConfirmAgentVoiceTranscript({
        transcript: "start Nvidia analysis",
        uncertain: false,
      })
    ).toBe(false);
    expect(
      shouldConfirmAgentVoiceTranscript({
        transcript: "",
        uncertain: false,
      })
    ).toBe(true);
    expect(
      shouldConfirmAgentVoiceTranscript({
        transcript: "maybe maybe",
        uncertain: true,
      })
    ).toBe(true);
  });

  it("throws sanitized backend errors", async () => {
    vi.spyOn(ApiService, "transcribeAgentVoice").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Vault locked" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      transcribeAgentVoice({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        audio: new Blob(["fake-audio"], { type: "audio/webm" }),
      })
    ).rejects.toThrow("Vault locked");
  });

  it("maps browser microphone failures to user-facing messages", () => {
    expect(
      getAgentVoiceStartErrorMessage(new DOMException("blocked", "NotAllowedError"))
    ).toContain("permission was denied");
    expect(
      getAgentVoiceStartErrorMessage(new DOMException("missing", "NotFoundError"))
    ).toContain("No microphone");
    expect(
      getAgentVoiceStartErrorMessage(new DOMException("busy", "NotReadableError"))
    ).toContain("already in use");
  });

  it("uses a shorter end-of-speech window after established speech", () => {
    expect(getAgentVoiceEndSilenceThresholdMs(250)).toBe(1200);
    expect(getAgentVoiceEndSilenceThresholdMs(900)).toBe(850);
  });

  it("tears down capture when MediaRecorder cannot start", async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
      getAudioTracks: () => [{ enabled: true }],
    } as unknown as MediaStream;
    const MediaRecorderMock = vi.fn(function MockMediaRecorder() {
      throw new DOMException("busy", "NotReadableError");
    });
    Object.assign(MediaRecorderMock, {
      isTypeSupported: vi.fn(() => false),
    });
    vi.stubGlobal("MediaRecorder", MediaRecorderMock);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    const client = new AgentVoiceClient();
    const errors: string[] = [];
    const statuses: string[] = [];

    await client.start({
      onError: (message) => errors.push(message),
      onStatus: (status) => statuses.push(status),
    });

    expect(client.isActive).toBe(false);
    expect(stop).toHaveBeenCalled();
    expect(errors).toEqual(["The microphone is already in use or could not be started."]);
    expect(statuses.at(-1)).toBe("idle");
  });
});
