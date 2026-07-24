import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { voiceMemoryStore } from "@/lib/voice/voice-memory-store";

describe("voiceMemoryStore durable memory vault gate", () => {
  const originalIndexedDb = globalThis.indexedDB;

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open: vi.fn(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: originalIndexedDb,
    });
  });

  it("does not read durable memory while the vault is locked", async () => {
    const rows = await voiceMemoryStore.retrieveDurable({
      userId: "user_1",
      query: "concise answers",
      vaultKey: "vault_key_material",
      vaultUnlocked: false,
    });

    expect(rows).toEqual([]);
    expect(globalThis.indexedDB.open).not.toHaveBeenCalled();
  });

  it("does not write durable memory without unlocked vault key material", async () => {
    const rows = await voiceMemoryStore.writeDurable({
      userId: "user_1",
      vaultUnlocked: true,
      vaultKey: "",
      candidates: [
        {
          category: "preferences",
          summary: "Prefers concise answers.",
        },
      ],
    });

    expect(rows).toEqual([]);
    expect(globalThis.indexedDB.open).not.toHaveBeenCalled();
  });
});
