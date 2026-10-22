import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock("@/lib/firebase/config", () => ({
  app: {},
  auth: { currentUser: null },
  getRecaptchaVerifier: vi.fn(),
  resetRecaptcha: vi.fn(),
}));
vi.mock("@/lib/capacitor", () => ({
  HushhPersonalKnowledgeModel: {},
  HushhVault: {
    encryptData: async ({
      plaintext,
      keyHex,
    }: {
      plaintext: string;
      keyHex: string;
    }) => encryptData(plaintext, keyHex),
  },
}));
import {
  PersonalKnowledgeModelService,
  type EncryptedDomainBlob,
} from "@/lib/services/personal-knowledge-model-service";
import { encryptData } from "@/lib/vault/encrypt";
import { readTodoListState } from "@/lib/services/todo-list-pkm-service";
const KEY = "01".repeat(32);
const data = {
  _private: {
    tasks: Array.from({ length: 401 }, (_, i) => ({
      id: `task-${i}`,
      title: `Full task ${i}`,
      notes: "Full note ".repeat(1000),
      type: "manual",
      status: "done",
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T01:00:00.000Z",
      completedAt: "2026-10-11T01:00:00.000Z",
      deletedAt: null,
      sourceAgent: null,
      sourceId: null,
      link: null,
      date: null,
      time: null,
      revision: 2,
    })),
    inventory: {
      complete: true,
      records: [
        {
          kind: "profile",
          id: "owner",
          revision: 3,
          value: { name: "Synthetic owner" },
        },
      ],
    },
  },
  "owner-key-with-dashes": { value: "Keep exact spelling" },
};
async function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const privateSegment = await encryptData(JSON.stringify(data._private), KEY);
  const root = await encryptData(
    JSON.stringify({ "owner-key-with-dashes": data["owner-key-with-dashes"] }),
    KEY,
  );
  const blob = {
    ...root,
    storageMode: "domain",
    userId: "owner",
    domain: "one_todos",
    contentRevision: 2,
    segments: { private: privateSegment, root },
  } as unknown as EncryptedDomainBlob;
  vi.spyOn(PersonalKnowledgeModelService, "getDomainData").mockResolvedValue(
    blob,
  );
  return blob;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("restores the exact complete encrypted owner record after segmented storage and a fresh read", async () => {
  await fixture();
  const loaded = await PersonalKnowledgeModelService.loadDomainDataWithBlob({
    userId: "owner",
    domain: "one_todos",
    vaultKey: KEY,
    vaultOwnerToken: "fixture-owner-token",
    forceRefresh: true,
  });
  expect(loaded.data).toEqual(data);
  expect(loaded.data).not.toHaveProperty("private");
  expect(readTodoListState(loaded.data).tasks).toHaveLength(401);
  expect(readTodoListState(loaded.data).tasks.at(-1)?.notes).toBe(
    data._private.tasks[400]!.notes,
  );
});
it("preserves the existing explicit partial-segment contract", async () => {
  const blob = await fixture();
  blob.ciphertext = "corrupt-complete-value";
  const loaded = await PersonalKnowledgeModelService.loadDomainDataWithBlob({
    userId: "owner",
    domain: "one_todos",
    vaultKey: KEY,
    vaultOwnerToken: "fixture-owner-token",
    segmentIds: ["private"],
    forceRefresh: true,
  });
  expect(loaded.data).toEqual({ private: data._private });
});
it("refuses a different owner's key instead of returning a partial record", async () => {
  await fixture();
  await expect(
    PersonalKnowledgeModelService.loadDomainDataWithBlob({
      userId: "other",
      domain: "one_todos",
      vaultKey: "02".repeat(32),
      vaultOwnerToken: "other-fixture-token",
      forceRefresh: true,
    }),
  ).rejects.toThrow();
});

it("new encrypted writes preserve noncanonical record keys in root across the actual segment read contract", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const write = PersonalKnowledgeModelService as unknown as {
    encryptDomainForStorage(params: {
      vaultKey: string;
      domainData: Record<string, unknown>;
    }): Promise<EncryptedDomainBlob>;
  };
  const prepared = await write.encryptDomainForStorage({
    vaultKey: KEY,
    domainData: data,
  });
  expect(Object.keys(prepared.segments ?? {})).toEqual(["root"]);
  vi.spyOn(PersonalKnowledgeModelService, "getDomainData").mockResolvedValue({
    ...prepared,
    ...prepared.segments!.root!,
    storageMode: "domain",
  } as EncryptedDomainBlob);
  const loaded = await PersonalKnowledgeModelService.loadDomainDataWithBlob({
    userId: "owner",
    domain: "one_todos",
    vaultKey: KEY,
    vaultOwnerToken: "fixture-owner-token",
    forceRefresh: true,
  });
  expect(loaded.data).toEqual(data);
});

it("routes actual new-write manifests to root for exact private and noncanonical keys", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { buildPersonalKnowledgeModelStructureArtifacts } =
    await import("@/lib/personal-knowledge-model/manifest");
  const write = PersonalKnowledgeModelService as unknown as {
    encryptDomainForStorage(params: {
      vaultKey: string;
      domainData: Record<string, unknown>;
    }): Promise<EncryptedDomainBlob>;
  };
  const scopedData = { ...data, _private: {tasks:data._private.tasks.slice(0,1)} };
  const prepared = await write.encryptDomainForStorage({
    vaultKey: KEY,
    domainData: scopedData,
  });
  const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
    domain: "one_todos",
    domainData: scopedData,
  });
  expect(manifest.segment_ids).toEqual(["root"]);
  for (const path of ["_private.tasks", "owner_key_with_dashes.value"]) {
    const segmentIds = PersonalKnowledgeModelService.resolveSegmentIdsForPaths({
      manifest,
      paths: [path],
    });
    expect(segmentIds).toEqual(["root"]);
    vi.spyOn(PersonalKnowledgeModelService, "getDomainData").mockResolvedValue({
      ...prepared,
      ...prepared.segments!.root!,
      storageMode: "domain",
    } as EncryptedDomainBlob);
    const loaded = await PersonalKnowledgeModelService.loadDomainDataWithBlob({
      userId: "owner",
      domain: "one_todos",
      vaultKey: KEY,
      vaultOwnerToken: "fixture-owner-token",
      segmentIds,
      forceRefresh: true,
    });
    expect(loaded.data).toEqual(scopedData);
  }
});
it("keeps canonical branches separately readable and rejects ambiguous segment routing", async () => {
  const {
    buildPersonalKnowledgeModelStructureArtifacts,
    PkmMetadataReviewRequired,
  } = await import("@/lib/personal-knowledge-model/manifest");
  const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
    domain: "preferences",
    domainData: { travel: { flight: "morning" }, note: "exact scalar" },
  });
  expect(
    PersonalKnowledgeModelService.resolveSegmentIdsForPaths({
      manifest,
      paths: ["travel.flight"],
    }),
  ).toEqual(["travel"]);
  expect(
    PersonalKnowledgeModelService.resolveSegmentIdsForPaths({
      manifest,
      paths: ["note"],
    }),
  ).toEqual(["root"]);
  expect(() =>
    buildPersonalKnowledgeModelStructureArtifacts({
      domain: "preferences",
      domainData: {
        travel: { flight: "morning" },
        Travel: { flight: "evening" },
      },
    }),
  ).toThrow(PkmMetadataReviewRequired);
});

it("preserves explicit private and _private branches independently of provider segment order", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const value = {
    _private: { tasks: [] },
    private: { custom: "Keep this separate" },
  };
  const write = PersonalKnowledgeModelService as unknown as {
    encryptDomainForStorage(params: {
      vaultKey: string;
      domainData: Record<string, unknown>;
    }): Promise<EncryptedDomainBlob>;
  };
  const prepared = await write.encryptDomainForStorage({
    vaultKey: KEY,
    domainData: value,
  });
  for (const reverse of [false, true]) {
    const entries = Object.entries(prepared.segments!);
    if (reverse) entries.reverse();
    vi.spyOn(PersonalKnowledgeModelService, "getDomainData").mockResolvedValue({
      ...prepared,
      segments: Object.fromEntries(entries),
      storageMode: "domain",
    } as EncryptedDomainBlob);
    const loaded = await PersonalKnowledgeModelService.loadDomainDataWithBlob({
      userId: "owner",
      domain: "one_todos",
      vaultKey: KEY,
      vaultOwnerToken: "fixture-owner-token",
      forceRefresh: true,
    });
    expect(loaded.data).toEqual(value);
  }
});
it("retains own prototype-shaped record keys without changing the object's prototype", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const value = Object.fromEntries([
    ["__proto__", { note: "Keep exact key" }],
    ["_private", { tasks: [] }],
  ]);
  const write = PersonalKnowledgeModelService as unknown as {
    encryptDomainForStorage(params: {
      vaultKey: string;
      domainData: Record<string, unknown>;
    }): Promise<EncryptedDomainBlob>;
  };
  const prepared = await write.encryptDomainForStorage({
    vaultKey: KEY,
    domainData: value,
  });
  vi.spyOn(PersonalKnowledgeModelService, "getDomainData").mockResolvedValue({
    ...prepared,
    storageMode: "domain",
  } as EncryptedDomainBlob);
  const loaded = await PersonalKnowledgeModelService.loadDomainDataWithBlob({
    userId: "owner",
    domain: "one_todos",
    vaultKey: KEY,
    vaultOwnerToken: "fixture-owner-token",
    forceRefresh: true,
  });
  expect(loaded.data).toEqual(value);
  expect(Object.hasOwn(loaded.data!, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(loaded.data)).toBe(Object.prototype);
});
it("refuses overlapping encrypted segments instead of silently replacing complete records", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const root = await encryptData(
    JSON.stringify({ accounts: { name: "first" } }),
    KEY,
  );
  const accounts = await encryptData(JSON.stringify({ name: "second" }), KEY);
  vi.spyOn(PersonalKnowledgeModelService, "getDomainData").mockResolvedValue({
    ...root,
    segments: { accounts, root },
    storageMode: "domain",
  } as EncryptedDomainBlob);
  await expect(
    PersonalKnowledgeModelService.loadDomainDataWithBlob({
      userId: "owner",
      domain: "preferences",
      vaultKey: KEY,
      vaultOwnerToken: "fixture-owner-token",
      forceRefresh: true,
    }),
  ).rejects.toThrow("overlapping record segments");
});

it("rejects stale supplied manifest routing at the write boundary before storing", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { buildPersonalKnowledgeModelStructureArtifacts } =
    await import("@/lib/personal-knowledge-model/manifest");
  const domainData = { "owner-key": { note: "Keep complete" } };
  const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
    domain: "preferences",
    domainData,
  });
  manifest.paths = manifest.paths.map((path) => ({
    ...path,
    segment_id: "owner_key",
  }));
  manifest.segment_ids = ["owner_key"];
  const write = PersonalKnowledgeModelService as unknown as {
    encryptDomainForStorage(params: {
      vaultKey: string;
      domainData: Record<string, unknown>;
    }): Promise<EncryptedDomainBlob>;
  };
  const encryptedBlob = await write.encryptDomainForStorage({
    vaultKey: KEY,
    domainData,
  });
  await expect(
    PersonalKnowledgeModelService.storeDomainData({
      userId: "owner",
      domain: "preferences",
      encryptedBlob,
      domainData,
      manifest,
      summary: {},
      vaultOwnerToken: "fixture-owner-token",
    }),
  ).rejects.toThrow("Memory metadata needs review before saving.");
});
it("decrypts a selected legacy segment despite corruption in an unselected root", async () => {
  const blob = await fixture();
  blob.segments!.root!.ciphertext = "corrupt-unselected-root";
  const selected = await PersonalKnowledgeModelService.loadDomainDataWithBlob({
    userId: "owner",
    domain: "one_todos",
    vaultKey: KEY,
    vaultOwnerToken: "fixture-owner-token",
    segmentIds: ["private"],
    forceRefresh: true,
  });
  expect(selected.data).toEqual({ private: data._private });
  await expect(
    PersonalKnowledgeModelService.loadDomainDataWithBlob({
      userId: "owner",
      domain: "one_todos",
      vaultKey: KEY,
      vaultOwnerToken: "fixture-owner-token",
      forceRefresh: true,
    }),
  ).rejects.toThrow();
});
it("canonical partial reads exclude root siblings and retain quarantine spelling", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const value = {
    travel: { flight: "morning" },
    _private: { secret: "UNSELECTED" },
    __quarantine_v1: { receipts: [] },
  };
  const write = PersonalKnowledgeModelService as unknown as {
    encryptDomainForStorage(params: {
      vaultKey: string;
      domainData: Record<string, unknown>;
    }): Promise<EncryptedDomainBlob>;
  };
  const prepared = await write.encryptDomainForStorage({
    vaultKey: KEY,
    domainData: value,
  });
  prepared.segments!.root!.ciphertext = "corrupt-unselected-root";
  expect(Object.keys(prepared.segments!)).toContain("__quarantine_v1");
  vi.spyOn(PersonalKnowledgeModelService, "getDomainData").mockResolvedValue({
    ...prepared,
    storageMode: "domain",
  } as EncryptedDomainBlob);
  for (const segment of ["travel", "__quarantine_v1"] as const) {
    const selected = await PersonalKnowledgeModelService.loadDomainDataWithBlob(
      {
        userId: "owner",
        domain: "preferences",
        vaultKey: KEY,
        vaultOwnerToken: "fixture-owner-token",
        segmentIds: [segment],
        forceRefresh: true,
      },
    );
    expect(selected.data).toEqual({ [segment]: value[segment] });
  }
});

it("binds optional caller segment IDs while preserving authority and unmaterialized declarations", async () => {
  const {
    bindPkmManifestStorageRouting,
    buildPersonalKnowledgeModelStructureArtifacts,
  } = await import("@/lib/personal-knowledge-model/manifest");
  const domainData = { holdings: { value: 42 } };
  const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
    domain: "financial",
    domainData,
  });
  const supplied = {
    ...manifest,
    paths: manifest.paths.map((path) => ({ ...path, segment_id: null })),
    segment_ids: ["reserved_empty"],
  };
  const bound = bindPkmManifestStorageRouting(domainData, supplied);
  expect(bound.paths).toEqual(manifest.paths);
  expect(bound.segment_ids).toContain("holdings");
  expect(bound.segment_ids).toContain("reserved_empty");
  expect(supplied.paths.every((path) => path.segment_id === null)).toBe(true);
});
