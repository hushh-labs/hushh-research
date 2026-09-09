import { describe, expect, it } from "vitest";

import {
  chooseLocalIntentPack,
  chooseLocalSpeechPack,
  chooseNativeFluidAudioPack,
  fetchLocalRuntimeCapability,
} from "@/lib/voice/local-runtime-capability";
import {
  isVoiceModelPackManifest,
  type LocalRuntimeCapability,
  type VoiceModelPackManifest,
} from "@/lib/voice/local-runtime-contract";

const pack = (version: string): VoiceModelPackManifest => ({
  pack_id: "voice-en",
  version,
  size_bytes: 1,
  checksum: "a".repeat(64),
  min_ram_gb: 1,
  min_storage_mb: 1,
  languages: ["en"],
  tasks: ["stt"],
  runtime: "sherpa_onnx_web",
  artifact_url: "https://models.example.test/voice.bin?Expires=4102444800&Signature=test",
  preprocessing_version: "pcm16k-v1",
  entrypoint: "sherpa_onnx_browser_streaming_v1",
  source_sha: "a".repeat(40),
  catalog_version: "agent-manifest-v2-test",
  license_notice_id: "test-license-notice",
  license_approved: false,
});

describe("local runtime capability contract", () => {
  it("rejects malformed capability payloads", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ available_packs: [] }), { status: 200 });
    await expect(fetchLocalRuntimeCapability(fetchImpl)).rejects.toThrow(
      "local_runtime_capability_invalid",
    );
  });

  it("rejects an unsigned artifact URL before the pack can be advertised", () => {
    expect(
      isVoiceModelPackManifest({
        ...pack("1.0.0"),
        artifact_url: "https://models.example.test/voice.bin",
      }),
    ).toBe(false);
  });

  it("chooses only an exactly matching installed English STT pack", () => {
    const oldPack = pack("1.0.0");
    const newPack = pack("2.0.0");
    const capability: LocalRuntimeCapability = {
      processing_mode_contract: ["cloud", "hybrid", "on_device"],
      offline_ready: false,
      installed_packs: [oldPack],
      available_packs: [newPack, oldPack],
      supported_tasks: ["stt"],
      fallback_mode: "hybrid",
    };
    expect(chooseLocalSpeechPack(capability)?.version).toBe("1.0.0");
  });

  it("selects only the generated intent ranker pack", () => {
    const intentPack: VoiceModelPackManifest = {
      ...pack("1.0.0"),
      pack_id: "one-intent-ranker",
      tasks: ["intent"],
      runtime: "onnxruntime_web",
      preprocessing_version: "minilm-action-head-v1",
      entrypoint: "one_voice_intent_ranker_v2",
    };
    expect(
      chooseLocalIntentPack({
        processing_mode_contract: ["cloud", "hybrid", "on_device"],
        offline_ready: false,
        installed_packs: [],
        available_packs: [intentPack],
        supported_tasks: ["intent"],
        fallback_mode: "hybrid",
      }),
    ).toEqual(intentPack);
  });

  it("selects only the legally approved reviewed native FluidAudio pack", () => {
    const deniedPack: VoiceModelPackManifest = {
      ...pack("2.0.0"),
      pack_id: "fluid-audio-parakeet-eou-120m-coreml-v1",
      runtime: "fluid_audio",
      entrypoint: "one_voice_fluid_audio_parakeet_eou_120m_v1",
      license_notice_id: "fluid-audio-parakeet-eou-120m-coreml-v1",
      license_approved: false,
    };
    const approvedPack: VoiceModelPackManifest = {
      ...deniedPack,
      version: "3.0.0",
      license_approved: true,
    };
    const capability: LocalRuntimeCapability = {
      processing_mode_contract: ["cloud", "hybrid", "on_device"],
      offline_ready: false,
      installed_packs: [],
      available_packs: [deniedPack, approvedPack],
      supported_tasks: ["stt"],
      fallback_mode: "hybrid",
    };

    expect(chooseNativeFluidAudioPack(capability)).toEqual(approvedPack);
  });
});
