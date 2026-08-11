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

  it("carries regulator_profile forward when saving picks", async () => {
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
    });

    const { plan } = await capturePlan();
    expect(plan.domainData.regulator_profile).toMatchObject(FACTS);
    expect(plan.domainData.advisor_package).toBeTruthy();
    expect(plan.summary).toMatchObject({ has_regulator_profile: true });
  });
});
