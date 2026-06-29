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
  },
}));

import {
  runLlmRedraft,
  OneKycClientZkService,
} from "@/lib/services/one-kyc-client-zk-service";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

// ---------------------------------------------------------------------------
// Fixture construction
//
// We use OneKycClientZkService.buildDraft directly (against a known exportPayload)
// so the returned localDraft has an internally consistent renderModel/approvedValues.
// This mirrors the approach in one-kyc-client-zk-service.redact.test.ts.
// ---------------------------------------------------------------------------

const FIXTURE_WORKFLOW = {
  id: "wf-redraft-llm-1",
  required_fields: ["full_name", "date_of_birth"],
  requested_scope: "attr.identity.*",
  subject: "Identity information",
  metadata: { account_holder_name: "Alice Test" },
} as unknown as OneKycWorkflow;

const FIXTURE_EXPORT_PAYLOAD = {
  full_name: "Alice Test",
  date_of_birth: "1990-05-15",
};

/** Build a round-tripping localDraft via buildDraft so tokens survive redact->resubstitute. */
async function makeFixture(): Promise<{
  localDraft: Awaited<ReturnType<typeof OneKycClientZkService.buildDraft>>;
  workflow: OneKycWorkflow;
  exportPayloads: NonNullable<
    Parameters<typeof OneKycClientZkService.buildDraft>[0]["exportPayloads"]
  >;
  tokenValue: string;
}> {
  const workflow = FIXTURE_WORKFLOW;
  const exportPayloads = [
    {
      scope: workflow.requested_scope,
      payload: FIXTURE_EXPORT_PAYLOAD as Record<string, unknown>,
    },
  ];

  const localDraft = await OneKycClientZkService.buildDraft({
    workflow,
    exportPayloads,
  });

  // Pick one known PII value that buildDraft will have placed in approvedValues.
  const tokenValue =
    localDraft.approvedValues["full_name"] ??
    localDraft.approvedValues["attr.identity.*.full_name"] ??
    Object.values(localDraft.approvedValues)[0] ??
    "Alice Test";

  return { localDraft, workflow, exportPayloads, tokenValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLlmRedraft", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok with an LLM draft when tokens are preserved and field set is unchanged", async () => {
    const { localDraft, workflow, exportPayloads, tokenValue } = await makeFixture();

    // llmRewrite prepends a deterministic sentinel to the tokenized content. Prepending
    // preserves every {{Fn}} token (so validateTokenIntegrity passes) AND guarantees the
    // edit appears in the final body — proving the rewrite survived the pipeline rather
    // than silently falling back to the original draft body.
    const SENTINEL = "[[LLM_EDIT_APPLIED]]";
    const llmRewrite = vi.fn(async (tmpl: string) => `${SENTINEL} ${tmpl}`);

    const result = await runLlmRedraft({
      localDraft,
      instruction: "warmer",
      workflow,
      exportPayloads,
      llmRewrite,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The LLM's textual edit actually survived into the final body.
      expect(result.draft.body).toContain(SENTINEL);
      // Real PII value is back in the body (re-substituted locally), never a token.
      expect(result.draft.body).toContain(tokenValue);
      expect(result.draft.body).not.toMatch(/\{\{F\d+\}\}/);
      expect(result.draft.htmlBody).toBeTruthy();
    }
    expect(llmRewrite).toHaveBeenCalledOnce();
  });

  it("fails closed with TOKEN_INTEGRITY when the LLM drops a token", async () => {
    const { localDraft, workflow, exportPayloads } = await makeFixture();

    // llmRewrite removes all placeholder tokens -> integrity check must fail.
    const llmRewrite = vi.fn(async (tmpl: string) =>
      tmpl.replace(/\{\{F\d+\}\}/g, "REDACTED")
    );

    const result = await runLlmRedraft({
      localDraft,
      instruction: "x",
      workflow,
      exportPayloads,
      llmRewrite,
    });

    expect(result).toEqual({ ok: false, errorCode: "TOKEN_INTEGRITY" });
  });

  it("fails closed with FIELD_SET_CHANGED when re-validated field keys differ", async () => {
    const { localDraft, workflow, exportPayloads } = await makeFixture();

    // llmRewrite is identity (tokens preserved).
    const llmRewrite = vi.fn(async (tmpl: string) => tmpl);

    // Force buildDraft to report a different consented field set on re-validation.
    vi.spyOn(OneKycClientZkService, "buildDraft").mockResolvedValueOnce({
      ...localDraft,
      approvedValues: {
        ...localDraft.approvedValues,
        __injected_extra_field__: "x",
      },
    });

    const result = await runLlmRedraft({
      localDraft,
      instruction: "x",
      workflow,
      exportPayloads,
      llmRewrite,
    });

    expect(result).toEqual({ ok: false, errorCode: "FIELD_SET_CHANGED" });
  });
});
