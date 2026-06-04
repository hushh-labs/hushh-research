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
