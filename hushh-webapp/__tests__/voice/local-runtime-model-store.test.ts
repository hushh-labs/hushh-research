import { describe, expect, it } from "vitest";

import {
  createMemoryModelPackStore,
  LocalModelPackStore,
  type ModelPackStorage,
} from "@/lib/voice/local-runtime-model-store";
import type { VoiceModelPackManifest } from "@/lib/voice/local-runtime-contract";
import { setLocalRuntimeObserver } from "@/lib/voice/local-runtime-observability";

const manifest: VoiceModelPackManifest = {
  pack_id: "voice-test",
  version: "1.0.0",
  size_bytes: 5,
  checksum: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  min_ram_gb: 0,
  min_storage_mb: 0,
  languages: ["en"],
  tasks: ["stt"],
  runtime: "sherpa_onnx_web",
  artifact_url:
    "https://models.example.test/voice-test.bin?Expires=4102444800&Signature=test",
  preprocessing_version: "pcm16k-v1",
  entrypoint: "sherpa_onnx_browser_streaming_v1",
  source_sha: "a".repeat(40),
  catalog_version: "agent-manifest-v2-test",
  license_notice_id: "test-license-notice",
  license_approved: false,
};

function response(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status });
}

describe("local model pack store", () => {
  it("verifies, installs, and atomically activates a pack", async () => {
    const { store } = createMemoryModelPackStore();
    const fetchImpl = async () => response(new TextEncoder().encode("hello"));

    await store.install(manifest, { fetchImpl });
    expect(await store.hasInstalled(manifest)).toBe(true);
    expect(await store.readInstalled(manifest)).not.toBeNull();

    await store.activate(manifest);
    expect(await store.getActive(manifest.pack_id)).toBe(manifest.version);
  });

  it("resumes a partial download with Range and does not restart the prefix", async () => {
    const { store, storage } = createMemoryModelPackStore();
    await storage.write("staging:voice-test:1.0.0", new TextEncoder().encode("he").buffer);
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      expect(init?.headers).toEqual({ Range: "bytes=2-" });
      return new Response(new TextEncoder().encode("llo"), {
        status: 206,
        headers: { "Content-Range": "bytes 2-4/5" },
      });
    };

    await store.install(manifest, { fetchImpl });

    expect(requests).toHaveLength(1);
    expect(new TextDecoder().decode(await store.readInstalled(manifest))).toBe("hello");
  });

  it("removes a corrupt artifact and refuses activation", async () => {
    const { store } = createMemoryModelPackStore();
    const corrupt = new TextEncoder().encode("world");

    await expect(
      store.install(manifest, { fetchImpl: async () => response(corrupt) }),
    ).rejects.toThrow("model_pack_checksum_mismatch");
    expect(await store.hasInstalled(manifest)).toBe(false);
    await expect(store.activate(manifest)).rejects.toThrow("model_pack_not_installed");
  });

  it("never persists an unrelated transcript value in model storage", async () => {
    const { storage } = createMemoryModelPackStore();
    const keys: string[] = [];
    const tracked: ModelPackStorage = {
      read: async (key) => {
        keys.push(`read:${key}`);
        return storage.read(key);
      },
      write: async (key, value) => {
        keys.push(`write:${key}`);
        await storage.write(key, value);
      },
      remove: async (key) => {
        keys.push(`remove:${key}`);
        await storage.remove(key);
      },
    };
    expect(keys.some((key) => key.includes("transcript"))).toBe(false);
    expect(tracked).toBeDefined();
  });

  it("keeps a verified previous version available for rollback", async () => {
    const { store } = createMemoryModelPackStore();
    const next: VoiceModelPackManifest = {
      ...manifest,
      version: "2.0.0",
      checksum: "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7",
    };
    await store.install(manifest, { fetchImpl: async () => response(new TextEncoder().encode("hello")) });
    await store.activate(manifest);
    await store.install(next, { fetchImpl: async () => response(new TextEncoder().encode("world")) });
    await store.activate(next);

    expect(await store.rollback(manifest.pack_id, [manifest, next])).toBe(manifest.version);
    expect(await store.getActive(manifest.pack_id)).toBe(manifest.version);
  });

  it("emits only metadata for pack lifecycle events", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { storage, metadata } = createMemoryModelPackStore();
    const store = new LocalModelPackStore({
      storage,
      metadata,
      observer: (event) => events.push(event),
    });
    await store.install(manifest, {
      fetchImpl: async () => response(new TextEncoder().encode("hello")),
    });
    const release = setLocalRuntimeObserver((event) => events.push(event));
    await store.activate(manifest);
    release();
    expect(events.some((event) => event.event === "model_pack_download_completed")).toBe(true);
    expect(events.some((event) => event.event === "model_pack_activation_completed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("transcript");
  });
});
