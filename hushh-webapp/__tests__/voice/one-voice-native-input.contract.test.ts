import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const microphoneCapture = readFileSync(
  join(
    process.cwd(),
    "ios/App/App/Plugins/OneVoiceMicrophoneCapture.swift",
  ),
  "utf8",
);
const invocationPlugin = readFileSync(
  join(
    process.cwd(),
    "ios/App/App/Plugins/HushhVoiceInvocationPlugin.swift",
  ),
  "utf8",
);
const invocationBridge = readFileSync(
  join(process.cwd(), "lib/capacitor/one-voice-invocation.ts"),
  "utf8",
);
const nativeInput = readFileSync(
  join(process.cwd(), "lib/voice/native-realtime-audio-input.ts"),
  "utf8",
);
const liveClient = readFileSync(
  join(process.cwd(), "lib/services/gemini-live-client.ts"),
  "utf8",
);
const agentBar = readFileSync(
  join(process.cwd(), "components/agent/agent-bar.tsx"),
  "utf8",
);

describe("One Voice iOS native PCM input contract", () => {
  it("converts the single native capture owner to the shared 16 kHz PCM16 format", () => {
    expect(microphoneCapture).toContain("public func startPCM16");
    expect(microphoneCapture).toContain("AVAudioConverter");
    expect(microphoneCapture).toContain("sampleRate: Double = 16_000");
    expect(microphoneCapture).toContain("channels: 1");
    expect(microphoneCapture).toContain(".pcmFormatInt16");
    expect(microphoneCapture).toContain("interleaved: true");
  });

  it("opens online capture without starting Apple or Fluid transcript recognition", () => {
    const start = invocationPlugin.indexOf(
      "@objc func startRealtimeAudioCapture",
    );
    const end = invocationPlugin.indexOf(
      "@objc func stopRealtimeAudioCapture",
      start,
    );
    const realtimeStart = invocationPlugin.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(realtimeStart).toContain("microphoneCapture.startPCM16");
    expect(realtimeStart).not.toContain("startAppleSpeechRecognition");
    expect(realtimeStart).not.toContain("startFluidAudioSpeechRecognition");
    expect(realtimeStart).not.toContain("startSpeechRecognitionInternal");
    expect(
      realtimeStart.indexOf("realtimeMicrophoneCapture = microphoneCapture"),
    ).toBeGreaterThan(realtimeStart.indexOf("try microphoneCapture.startPCM16"));
  });

  it("batches bounded PCM delivery and defaults native capture to provider endpointing", () => {
    expect(invocationPlugin).toContain('"oneVoiceAudioFrame"');
    expect(invocationPlugin).toContain('"oneVoiceAudioState"');
    expect(invocationPlugin).toContain('state: "delivery_backpressure"');
    expect(invocationPlugin).toContain('state: "sequence_gap"');
    expect(invocationPlugin).toContain("realtimeAudioTargetPacketFrames = 1_600");
    expect(invocationPlugin).toContain("realtimeAudioMaximumPendingPackets = 4");
    expect(invocationPlugin).toContain("nextPacketSequence = 0");
    expect(invocationPlugin).toContain("realtimeAudioDeliveryQueue");
    expect(invocationPlugin).toContain(
      'let requiresExplicitTurn = call.getBool("requiresExplicitTurn") ?? false',
    );
    expect(invocationPlugin).toContain(
      "explicitTurnMode: requiresExplicitTurn",
    );
    expect(invocationPlugin).toContain('state: "first_frame"');
    expect(invocationPlugin).toContain('errorCode: "audio_session_interrupted"');
    expect(invocationPlugin).toContain('errorCode: "audio_route_changed"');
    expect(invocationPlugin).toContain("AVAudioSessionRouteChangeReasonKey");
    expect(invocationPlugin).toContain(
      "AVAudioSession.RouteChangeReason(rawValue: rawReason) == .categoryChange",
    );
    expect(invocationPlugin).toContain('errorCode: "audio_engine_reconfigured"');
    expect(invocationPlugin).toContain('errorCode: "audio_media_services_reset"');
    expect(invocationPlugin).toContain('errorCode: "app_backgrounded"');
    expect(invocationPlugin).not.toContain("realtimeAudioMaximumPendingFrames");
    expect(invocationPlugin).not.toContain("realtimeAudioActivityStartLevel");
    expect(invocationPlugin).toContain("[ONE_VOICE_PCM] state=");
    expect(invocationPlugin).not.toContain("print(frame.data");
  });

  it("keeps the Capacitor capture surface typed while automatic endpointing is the default", () => {
    expect(invocationBridge).toContain("startRealtimeAudioCapture");
    expect(invocationBridge).toContain("stopRealtimeAudioCapture");
    expect(invocationBridge).toContain("addRealtimeAudioFrameListener");
    expect(invocationBridge).toContain("addRealtimeAudioStateListener");
    expect(invocationBridge).toContain('encoding: "pcm_s16le"');
    expect(invocationBridge).toContain("normalizeRealtimeAudioCaptureStartResult");
    expect(invocationBridge).toContain("normalizeRealtimeAudioFrame");
    expect(invocationBridge).toContain("normalizeRealtimeAudioState");
    expect(liveClient).toContain("requiresExplicitInputTurn: false");
    expect(liveClient).toContain('state === "speech_ended"');
  });

  it("forwards native PCM directly into the shared Live transport", () => {
    expect(nativeInput).toContain("class NativeRealtimeAudioInput");
    expect(nativeInput).toContain("addRealtimeAudioFrameListener");
    expect(nativeInput).toContain("startRealtimeAudioCapture");
    expect(nativeInput).toContain("decodeBase64Pcm");
    expect(nativeInput).toContain("native_packet_sequence_gap");
    expect(liveClient).toContain("realtimeAudioInput");
    expect(liveClient).toContain("handleRealtimePcmFrame");
    expect(liveClient).toContain("Live, not an iOS/native manual turn, owns speech endpointing.");
    expect(liveClient).toContain('type: "location_command_endpointed"');
    expect(liveClient).toContain("void this.stopAudioInput()");
  });

  it("opens iOS command capture on native PCM without a warm socket", () => {
    const commandStartAt = agentBar.indexOf(
      "const relaySessionPromise = ApiService.getOneAdkLiveRelaySession",
    );
    const commandStart = agentBar.slice(
      commandStartAt,
      agentBar.indexOf(
        "const runtimeConnection = await resolveGeminiRuntimeConnection",
        commandStartAt,
      ),
    );

    expect(commandStartAt).toBeGreaterThan(-1);
    expect(commandStart).toContain(
      "const realtimeAudioInput = createOneVoiceRealtimeAudioInput();",
    );
    expect(commandStart).toContain("locationCommandMode: true,");
    expect(agentBar).not.toContain('activationSource: "foreground_warm"');
    expect(nativeInput).toContain("startRealtimeAudioCapture");
    expect(liveClient).toContain("if (this.realtimeAudioInput)");
    expect(liveClient).toContain("await input.start");
  });
});
