import { describe, it, expect, vi, beforeEach } from "vitest";

// The module under test imports OneKycService and PKM services at module load.
// Mock them so the orchestrator can be imported in isolation.
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

vi.mock("@/lib/services/one-kyc-service", () => ({
  OneKycService: {
    getClientConnector: vi.fn(),
    registerClientConnector: vi.fn(),
    redraftWithLlm: vi.fn(),
    redraftFull: vi.fn(),
  },
}));

import {
  runFullRedraft,
  OneKycClientZkService,
} from "@/lib/services/one-kyc-client-zk-service";
import { OneKycService } from "@/lib/services/one-kyc-service";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_WORKFLOW = {
  workflow_id: "wf-full-1",
  id: "wf-full-1",
  required_fields: ["full_name", "date_of_birth"],
  requested_scope: "attr.identity.*",
  selected_scopes: ["attr.identity.*"],
  subject: "Identity information",
  metadata: { account_holder_name: "Alice Test" },
} as unknown as OneKycWorkflow;

const FIXTURE_EXPORT_PAYLOAD = {
  full_name: "Alice Test",
  date_of_birth: "1990-05-15",
};

const FIXTURE_EXPORT_PAYLOADS = [
  {
    scope: "attr.identity.*",
    exportRevision: 3,
    payload: FIXTURE_EXPORT_PAYLOAD as Record<string, unknown>,
  },
];

async function makeLocalDraft(): Promise<
  Awaited<ReturnType<typeof OneKycClientZkService.buildDraft>>
> {
  const exportPayloads = [
    {
      scope: FIXTURE_WORKFLOW.requested_scope,
      payload: FIXTURE_EXPORT_PAYLOAD as Record<string, unknown>,
    },
  ];
  return OneKycClientZkService.buildDraft({
    workflow: FIXTURE_WORKFLOW,
    exportPayloads,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runFullRedraft", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:true with body === rewritten_body from server response", async () => {
    const localDraft = await makeLocalDraft();
    const rewritten = "Dear Alice,\n\nYour date of birth is 1990-05-15. Warm regards.";

    vi.mocked(OneKycService.redraftFull).mockResolvedValueOnce({
      rewritten_body: rewritten,
    });

    const result = await runFullRedraft({
      localDraft,
      instruction: "warmer",
      workflow: FIXTURE_WORKFLOW,
      exportPayloads: FIXTURE_EXPORT_PAYLOADS,
      input: { userId: "u1", vaultOwnerToken: "tok", workflowId: FIXTURE_WORKFLOW.workflow_id },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.body).toBe(rewritten);
      expect(result.draft.htmlBody).toBeTruthy();
      // htmlBody must be derived from rewritten_body, not the original body.
      expect(result.draft.htmlBody).toContain("Alice");
      // draftHash is a 64-char hex string.
      expect(result.draft.draftHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("calls OneKycService.redraftFull with the correct arguments", async () => {
    const localDraft = await makeLocalDraft();
    const rewritten = "Rewritten email body.";

    vi.mocked(OneKycService.redraftFull).mockResolvedValueOnce({
      rewritten_body: rewritten,
    });

    await runFullRedraft({
      localDraft,
      instruction: "be concise",
      workflow: FIXTURE_WORKFLOW,
      exportPayloads: FIXTURE_EXPORT_PAYLOADS,
      input: { userId: "u1", vaultOwnerToken: "tok", workflowId: FIXTURE_WORKFLOW.workflow_id },
    });

    expect(OneKycService.redraftFull).toHaveBeenCalledWith({
      userId: "u1",
      vaultOwnerToken: "tok",
      workflowId: FIXTURE_WORKFLOW.workflow_id,
      draftBody: localDraft.body,
      instruction: "be concise",
      approvedScopes: ["attr.identity.*"],
      requestText: "Identity information",
      domains: [
        {
          domain: "identity",
          scope: "attr.identity.*",
          exportRevision: 3,
          domainData: FIXTURE_EXPORT_PAYLOAD,
        },
      ],
    });
  });

  it("propagates network errors from OneKycService.redraftFull", async () => {
    const localDraft = await makeLocalDraft();

    vi.mocked(OneKycService.redraftFull).mockRejectedValueOnce(
      new Error("Network failure")
    );

    await expect(
      runFullRedraft({
        localDraft,
        instruction: "shorter",
        workflow: FIXTURE_WORKFLOW,
        exportPayloads: FIXTURE_EXPORT_PAYLOADS,
        input: { userId: "u1", vaultOwnerToken: "tok", workflowId: FIXTURE_WORKFLOW.workflow_id },
      })
    ).rejects.toThrow("Network failure");
  });

  it("rejects an empty rewritten body", async () => {
    const localDraft = await makeLocalDraft();
    vi.mocked(OneKycService.redraftFull).mockResolvedValueOnce({
      rewritten_body: "   ",
    });

    await expect(
      runFullRedraft({
        localDraft,
        instruction: "shorter",
        workflow: FIXTURE_WORKFLOW,
        exportPayloads: FIXTURE_EXPORT_PAYLOADS,
        input: { userId: "u1", vaultOwnerToken: "tok", workflowId: FIXTURE_WORKFLOW.workflow_id },
      })
    ).rejects.toThrow("empty response");
  });
});
