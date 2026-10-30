import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
const loadDomainDataMock = vi.fn();
const saveMergedDomainMock = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  },
}));

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    read: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainData: (...args: unknown[]) => loadDomainDataMock(...args),
  },
  PkmScopeExposureError: class PkmScopeExposureError extends Error {},
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: (...args: unknown[]) => saveMergedDomainMock(...args),
  },
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: vi.fn(),
  toEventResult: vi.fn((value) => value),
  toStatusBucket: vi.fn((value) => value),
}));

vi.mock("@/lib/observability/growth", () => ({
  resolveGrowthWorkspaceSource: vi.fn(() => "test"),
  trackGrowthFunnelStepCompleted: vi.fn(),
}));

const FACTS = {
  crd_number: "5308823",
  regulator: "SEC",
  regulator_status: "active",
  exams: [{ code: "S65" }],
};

const PICKS_PAYLOAD = {
  top_picks: [],
  avoid_rows: [],
  screening_sections: [],
  package_note: null,
  revision: 3,
  updated_at: "2026-08-01T00:00:00.000Z",
};

async function capturePlan(): Promise<{
  params: Record<string, any>;
  plan: { domainData: Record<string, unknown>; summary: Record<string, unknown> };
}> {
  const params = saveMergedDomainMock.mock.calls[0][0];
  const plan = await params.build({});
  return { params, plan };
}

describe("RiaService.saveRegulatorProfile", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
    loadDomainDataMock.mockReset();
    saveMergedDomainMock.mockReset();
    saveMergedDomainMock.mockResolvedValue({ success: true, dataVersion: 2 });
  });

  it("writes regulator_profile with an owner confirmation from the claim", async () => {
    loadDomainDataMock.mockResolvedValue(null);
    const { RiaService } = await import("@/lib/services/ria-service");

    const ok = await RiaService.saveRegulatorProfile({
      userId: "u1",
      vaultKey: "key",
      vaultOwnerToken: "token",
      facts: FACTS,
    });

    expect(ok).toBe(true);
    const { params, plan } = await capturePlan();
    expect(params.domain).toBe("ria");
    expect(params.confirmation).toMatchObject({
      confirmedByUser: true,
      source: "ria_identity_claim_regulator_facts",
    });
    expect(plan.domainData.regulator_profile).toMatchObject(FACTS);
    expect(plan.summary).toMatchObject({ has_regulator_profile: true });
  });

  it("keeps an existing picks package beside the new regulator_profile", async () => {
    loadDomainDataMock.mockResolvedValue({
      schema_version: 1,
      advisor_package: PICKS_PAYLOAD,
    });
    const { RiaService } = await import("@/lib/services/ria-service");

    await RiaService.saveRegulatorProfile({
      userId: "u1",
      vaultKey: "key",
      vaultOwnerToken: "token",
      facts: FACTS,
    });

    const { plan } = await capturePlan();
    expect(plan.domainData.advisor_package).toMatchObject({ revision: 3 });
    expect(plan.domainData.regulator_profile).toMatchObject(FACTS);
    expect(plan.summary).toMatchObject({
      has_regulator_profile: true,
      package_revision: 3,
    });
  });

  it("reports a blocked save without throwing", async () => {
    loadDomainDataMock.mockRejectedValue(new Error("vault locked"));
    saveMergedDomainMock.mockResolvedValue({ success: false });
    const { RiaService } = await import("@/lib/services/ria-service");

    const ok = await RiaService.saveRegulatorProfile({
      userId: "u1",
      vaultKey: null,
      vaultOwnerToken: null,
      facts: FACTS,
    });

    expect(ok).toBe(false);
  });
});

describe("RiaService.savePickPackage sibling preservation", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
    loadDomainDataMock.mockReset();
    saveMergedDomainMock.mockReset();
    saveMergedDomainMock.mockResolvedValue({ success: true, dataVersion: 4 });
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ metadata: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("carries regulator_profile and investor debate context forward when saving picks", async () => {
    loadDomainDataMock.mockResolvedValue({
      schema_version: 1,
      advisor_package: PICKS_PAYLOAD,
      regulator_profile: { ...FACTS, updated_at: "2026-08-07T00:00:00.000Z" },
    });
    const { RiaService } = await import("@/lib/services/ria-service");

    await RiaService.savePickPackage({
      idToken: "id-token",
      userId: "u1",
      vaultKey: "key",
      vaultOwnerToken: "token",
      top_picks: [],
      avoid_rows: [],
      screening_sections: [],
      investor_debate_thesis: "Pressure-test downside risk against the portfolio's concentration.",
    });

    const { plan } = await capturePlan();
    expect(plan.domainData.regulator_profile).toMatchObject(FACTS);
    expect(plan.domainData.advisor_package).toMatchObject({
      investor_debate_thesis:
        "Pressure-test downside risk against the portfolio's concentration.",
    });
    expect(plan.summary).toMatchObject({ has_regulator_profile: true });
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/picks",
      expect.objectContaining({
        body: expect.stringContaining(
          '"investor_debate_thesis":"Pressure-test downside risk against the portfolio\'s concentration."',
        ),
      }),
    );
  });

  it("bounds and attributes advisor theses before PKM and share sync", async () => {
    loadDomainDataMock.mockResolvedValue(null);
    const { RiaService } = await import("@/lib/services/ria-service");
    const longThesis = ` ${"A".repeat(2100)} `;

    await RiaService.savePickPackage({
      idToken: "id-token",
      userId: "ria-user-1",
      vaultKey: "key",
      vaultOwnerToken: "token",
      top_picks: [
        {
          ticker: "NVDA",
          tier: "ACE",
          investment_thesis: longThesis,
        },
      ],
      avoid_rows: [],
      screening_sections: [],
    });

    const { plan } = await capturePlan();
    const row = (plan.domainData.advisor_package as any).top_picks[0];
    expect(row.investment_thesis).toHaveLength(2000);
    expect(row.advisor_thesis).toMatchObject({
      text: row.investment_thesis,
      authored_by_user_id: "ria-user-1",
      source: "ria_picks_editor",
    });
    expect(typeof row.advisor_thesis.updated_at).toBe("string");
    const syncRequest = apiFetchMock.mock.calls.at(-1)?.[1];
    const syncBody = JSON.parse(syncRequest.body);
    expect(syncBody.top_picks[0]).toMatchObject({
      investment_thesis: row.investment_thesis,
      advisor_thesis: expect.objectContaining({
        authored_by_user_id: "ria-user-1",
        source: "ria_picks_editor",
      }),
    });
  });

  it("represents a removed advisor thesis as absent metadata before PKM and share sync", async () => {
    loadDomainDataMock.mockResolvedValue(null);
    const { RiaService } = await import("@/lib/services/ria-service");

    await RiaService.savePickPackage({
      idToken: "id-token",
      userId: "ria-user-1",
      vaultKey: "key",
      vaultOwnerToken: "token",
      top_picks: [
        {
          ticker: "NVDA",
          tier: "ACE",
          investment_thesis: "   ",
          advisor_thesis: {
            text: "Prior advisor view",
            authored_by_user_id: "ria-user-1",
            source: "ria_picks_editor",
            updated_at: "2026-08-27T00:00:00Z",
          },
        },
      ],
      avoid_rows: [],
      screening_sections: [],
    });

    const { plan } = await capturePlan();
    const row = (plan.domainData.advisor_package as any).top_picks[0];
    expect(row.investment_thesis).toBeNull();
    expect(row.advisor_thesis).toBeNull();
    const syncRequest = apiFetchMock.mock.calls.at(-1)?.[1];
    const syncBody = JSON.parse(syncRequest.body);
    expect(syncBody.top_picks[0].investment_thesis).toBeNull();
    expect(syncBody.top_picks[0].advisor_thesis).toBeNull();
  });
});
