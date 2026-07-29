import { beforeEach, describe, expect, it, vi } from "vitest";

const pkmMocks = vi.hoisted(() => ({
  getDomainManifest: vi.fn(),
  getDomainData: vi.fn(),
  loadDomainData: vi.fn(),
  loadFullBlob: vi.fn(),
  getEncryptedData: vi.fn(),
  resolveSegmentIdsForPaths: vi.fn(),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: pkmMocks,
}));

import {
  buildConsentExportForScope,
  ConsentExportNoDataError,
} from "@/lib/consent/export-builder";

const manifest = {
  domain: "travel",
  manifest_version: 4,
  summary_projection: {},
  top_level_scope_paths: ["seat_preferences"],
  externalizable_paths: ["seat_preferences.summary"],
  segment_ids: ["seat_preferences"],
  paths: [
    {
      json_path: "seat_preferences",
      path_type: "object",
      exposure_eligibility: true,
      segment_id: "seat_preferences",
    },
    {
      json_path: "seat_preferences.summary",
      path_type: "leaf",
      exposure_eligibility: true,
      segment_id: "seat_preferences",
    },
  ],
};

describe("buildConsentExportForScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pkmMocks.getDomainManifest.mockResolvedValue(manifest);
    pkmMocks.getDomainData.mockResolvedValue({ dataVersion: 12 });
    pkmMocks.loadDomainData.mockResolvedValue({
      seat_preferences: {
        summary: "Prefers aisle seats near the front.",
      },
    });
    pkmMocks.resolveSegmentIdsForPaths.mockReturnValue(["seat_preferences"]);
  });

  it("exports broad domain scopes without forcing the root segment", async () => {
    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.travel.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    expect(pkmMocks.getDomainData).toHaveBeenCalledWith(
      "user_1",
      "travel",
      "vault-owner",
      []
    );
    expect(pkmMocks.loadDomainData).toHaveBeenCalledWith({
      userId: "user_1",
      domain: "travel",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      segmentIds: [],
    });
    expect(built.payload.travel).toEqual({
      seat_preferences: {
        summary: "Prefers aisle seats near the front.",
      },
    });
    expect(built.payload.__export_metadata).toMatchObject({
      scope: "attr.travel.*",
      approved_segment_ids: [],
    });
    expect(built.sourceContentRevision).toBe(12);
  });

  it("exports only the requested path scope when the segment exists", async () => {
    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.travel.seat_preferences.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    expect(pkmMocks.resolveSegmentIdsForPaths).toHaveBeenCalledWith({
      manifest,
      paths: ["seat_preferences", "seat_preferences.summary"],
    });
    expect(pkmMocks.getDomainData).toHaveBeenCalledWith(
      "user_1",
      "travel",
      "vault-owner",
      ["seat_preferences"]
    );
    expect(built.payload).toMatchObject({
      travel: {
        seat_preferences: {
          summary: "Prefers aisle seats near the front.",
        },
      },
      __export_metadata: {
        approved_segment_ids: ["seat_preferences"],
      },
    });
  });

  it("falls back to whole-domain read when a path segment lookup misses", async () => {
    pkmMocks.resolveSegmentIdsForPaths.mockReturnValue(["root"]);
    pkmMocks.getDomainData.mockResolvedValueOnce(null).mockResolvedValueOnce({ dataVersion: 13 });

    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.travel.seat_preferences.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    expect(pkmMocks.getDomainData).toHaveBeenNthCalledWith(
      1,
      "user_1",
      "travel",
      "vault-owner",
      ["root", "seat_preferences"]
    );
    expect(pkmMocks.getDomainData).toHaveBeenNthCalledWith(
      2,
      "user_1",
      "travel",
      "vault-owner",
      []
    );
    expect(pkmMocks.loadDomainData).toHaveBeenCalledWith({
      userId: "user_1",
      domain: "travel",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      segmentIds: [],
    });
    expect(built.payload.travel).toEqual({
      seat_preferences: {
        summary: "Prefers aisle seats near the front.",
      },
    });
  });

  it("includes the requested top-level segment when manifest metadata still points at root", async () => {
    const financialManifest = {
      ...manifest,
      domain: "financial",
      top_level_scope_paths: ["portfolio"],
      externalizable_paths: ["portfolio", "portfolio.total_value"],
      segment_ids: ["root"],
      paths: [
        {
          json_path: "portfolio",
          path_type: "object",
          exposure_eligibility: true,
          segment_id: "root",
        },
        {
          json_path: "portfolio.total_value",
          path_type: "leaf",
          exposure_eligibility: true,
          segment_id: "root",
        },
      ],
    };
    pkmMocks.getDomainManifest.mockResolvedValueOnce(financialManifest);
    pkmMocks.resolveSegmentIdsForPaths.mockReturnValueOnce(["root"]);
    pkmMocks.loadDomainData.mockResolvedValueOnce({
      portfolio: {
        total_value: 125000,
      },
    });

    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.financial.portfolio.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    expect(pkmMocks.getDomainData).toHaveBeenCalledWith(
      "user_1",
      "financial",
      "vault-owner",
      ["root", "portfolio"]
    );
    expect(pkmMocks.loadDomainData).toHaveBeenCalledWith({
      userId: "user_1",
      domain: "financial",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      segmentIds: ["root", "portfolio"],
    });
    expect(built.payload.financial).toEqual({
      portfolio: {
        total_value: 125000,
      },
    });
  });

  it("blocks approval when the selected PKM scope has no shareable values", async () => {
    pkmMocks.loadDomainData
      .mockResolvedValueOnce({ seat_preferences: {} })
      .mockResolvedValueOnce({ seat_preferences: {} });

    await expect(
      buildConsentExportForScope({
        userId: "user_1",
        scope: "attr.travel.seat_preferences.*",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner",
      })
    ).rejects.toBeInstanceOf(ConsentExportNoDataError);
  });
});

// ── Metadata map schema bounds ────────────────────────────────────────────────
//
// The export engine must enforce a rigid schema on the __export_metadata map
// regardless of how large, deeply nested, or character-corrupted the inbound
// domain data or manifest payloads are.
//
// Boundary contracts under test:
//   1. __export_metadata always emits exactly the canonical 6-field schema.
//   2. A maximally wide flat map with all-empty values is rejected.
//   3. A deeply nested all-null map is rejected.
//   4. Segment IDs with special characters and uppercase are clamped to [a-z0-9_].
//   5. A deeply nested map with one non-empty leaf is treated as shareable.
//   6. A wide map dominated by null values is shareable if one valid string exists.
//   7. export_timestamp is always a valid ISO 8601 string regardless of payload size.

describe("buildConsentExportForScope — metadata map schema bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pkmMocks.getDomainManifest.mockResolvedValue(manifest);
    pkmMocks.getDomainData.mockResolvedValue({ dataVersion: 12 });
    pkmMocks.loadDomainData.mockResolvedValue({
      seat_preferences: { summary: "Prefers aisle seats near the front." },
    });
    pkmMocks.resolveSegmentIdsForPaths.mockReturnValue(["seat_preferences"]);
  });

  it("emits exactly the canonical 6-field __export_metadata schema when domain payload has 200 keys", async () => {
    const widePayload = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`field_${i}`, `value_${i}`])
    );
    pkmMocks.loadDomainData.mockResolvedValueOnce({ seat_preferences: widePayload });

    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.travel.seat_preferences.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    expect(
      Object.keys(built.payload.__export_metadata as object).sort()
    ).toEqual([
      "approved_paths",
      "approved_segment_ids",
      "export_timestamp",
      "manifest_version",
      "scope",
      "source_domain",
    ]);
  });

  it("throws ConsentExportNoDataError when a 200-key flat metadata map contains exclusively empty-string values", async () => {
    const allEmpty = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`field_${i}`, ""])
    );
    // Two mocks: first for the targeted-segment load, second for the full-domain
    // fallback load the engine attempts before giving up.
    pkmMocks.loadDomainData
      .mockResolvedValueOnce({ seat_preferences: allEmpty })
      .mockResolvedValueOnce({ seat_preferences: allEmpty });

    await expect(
      buildConsentExportForScope({
        userId: "user_1",
        scope: "attr.travel.seat_preferences.*",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner",
      })
    ).rejects.toBeInstanceOf(ConsentExportNoDataError);
  });

  it("throws ConsentExportNoDataError when a 10-level deeply nested map has exclusively null leaf values", async () => {
    function buildDeepNull(depth: number): unknown {
      return depth === 0 ? null : { nested: buildDeepNull(depth - 1) };
    }
    pkmMocks.loadDomainData
      .mockResolvedValueOnce({ seat_preferences: buildDeepNull(10) })
      .mockResolvedValueOnce({ seat_preferences: buildDeepNull(10) });

    await expect(
      buildConsentExportForScope({
        userId: "user_1",
        scope: "attr.travel.seat_preferences.*",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner",
      })
    ).rejects.toBeInstanceOf(ConsentExportNoDataError);
  });

  it("clamps segment IDs with special characters and uppercase to [a-z0-9_] in __export_metadata.approved_segment_ids", async () => {
    // The engine normalises via normalizeSegmentCandidate before placing IDs in the
    // metadata map — raw symbols and capital letters must never appear verbatim.
    pkmMocks.resolveSegmentIdsForPaths.mockReturnValueOnce([
      "Seat-Preferences!!!",
      "PROFILE_DATA",
    ]);

    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.travel.seat_preferences.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    const meta = built.payload.__export_metadata as Record<string, unknown>;
    const segmentIds = meta.approved_segment_ids as string[];

    for (const id of segmentIds) {
      expect(id).toMatch(/^[a-z0-9_]+$/);
    }
    expect(segmentIds).not.toContain("Seat-Preferences!!!");
    expect(segmentIds).not.toContain("PROFILE_DATA");
  });

  it("does not throw when a 10-level deeply nested domain map has at least one non-empty string leaf", async () => {
    const deepValue = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: "deep-content" } } } } } } } } },
    };
    pkmMocks.loadDomainData.mockResolvedValueOnce({ seat_preferences: deepValue });

    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.travel.seat_preferences.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    const meta = built.payload.__export_metadata as Record<string, unknown>;
    expect(meta.scope).toBe("attr.travel.seat_preferences.*");
    expect(meta.source_domain).toBe("travel");
  });

  it("does not throw when a 200-key map has 199 null/empty values but one valid non-empty string", async () => {
    const mixedPayload = Object.fromEntries([
      ...Array.from({ length: 100 }, (_, i) => [`empty_${i}`, ""]),
      ...Array.from({ length: 99 }, (_, i) => [`null_${i}`, null]),
      ["valid_field", "this is a real value"],
    ]);
    pkmMocks.loadDomainData.mockResolvedValueOnce({ seat_preferences: mixedPayload });

    await expect(
      buildConsentExportForScope({
        userId: "user_1",
        scope: "attr.travel.seat_preferences.*",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner",
      })
    ).resolves.toBeDefined();
  });

  it("always writes export_timestamp as a valid ISO 8601 string regardless of domain payload size", async () => {
    const widePayload = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`f${i}`, `v${i}`])
    );
    pkmMocks.loadDomainData.mockResolvedValueOnce({ seat_preferences: widePayload });

    const built = await buildConsentExportForScope({
      userId: "user_1",
      scope: "attr.travel.seat_preferences.*",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    const meta = built.payload.__export_metadata as Record<string, unknown>;
    const ts = meta.export_timestamp as string;
    expect(typeof ts).toBe("string");
    // toISOString() is idempotent on its own output — round-trip proves format validity.
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});
