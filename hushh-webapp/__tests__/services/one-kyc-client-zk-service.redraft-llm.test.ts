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
// Portfolio fixture (financial scope — needed for holdings <th> table tests)
//
// Uses attr.financial.* scope with a portfolio payload that has holdings rows.
// buildDraft → formatPortfolioApprovedValue → "Holdings\n- AAPL: ..." plain text
// → blockToRenderBlocks → htmlTable → <th> headers in the HTML body.
//
// Tokenization architecture note:
// buildDraft consolidates the entire portfolio block (Portfolio summary + Holdings)
// into a SINGLE approvedValue ("financial_information"). This means the whole block
// becomes {{F0}}, so "Holdings\n" is inside the token and cannot be selectively
// removed from the tokenized template.
//
// To enable the structure-loss test (which needs "Holdings\n" to be literal text in
// the template so it can be stripped while preserving tokens), we override
// approvedValues with the individual holding LINE values. These substrings appear
// verbatim in the body, so redactDraftForLlm tokenizes them individually, leaving
// the "Holdings\n" heading as literal structural text in the template.
//
// The fixture still uses buildDraft for htmlBody/body/renderModel (so the first-draft
// <th> table is authentic). The modified approvedValues are used for the redraft path.
// Tests that call buildDraft internally (for FIELD_SET_CHANGED re-validation) mock it
// to return this same fixture so the key-set check passes.
// ---------------------------------------------------------------------------

const PORTFOLIO_WORKFLOW = {
  id: "wf-portfolio-1",
  required_fields: [],
  requested_scope: "attr.financial.*",
  subject: "Portfolio information",
  metadata: { account_holder_name: "Bob Investor" },
} as unknown as OneKycWorkflow;

const PORTFOLIO_EXPORT_PAYLOAD = {
  portfolio: {
    account_info: { brokerage_name: "Fidelity", account_type: "Individual TOD" },
    account_summary: { ending_value: 100000, cash_balance: 5000 },
    holdings: [
      { symbol: "AAPL", quantity: 100, market_value: 15000 },
      { symbol: "MSFT", quantity: 50, market_value: 15000 },
    ],
  },
};

// Individual holding line values as produced by formatHoldingLine for the above payload.
// These must appear verbatim in the body produced by buildDraft so redactDraftForLlm
// can tokenize them individually (confirmed via debug run against the actual renderer).
const PORTFOLIO_HOLDING_APPROVED_VALUES: Record<string, string> = {
  aapl_holding: "AAPL: 100 shares; $15,000.00 value; $150.00 per share",
  msft_holding: "MSFT: 50 shares; $15,000.00 value; $300.00 per share",
};

/** Build a portfolio localDraft via buildDraft — its htmlBody must contain <th> (holdings table). */
async function makePortfolioFixture(): Promise<{
  portfolioLocalDraft: Awaited<ReturnType<typeof OneKycClientZkService.buildDraft>>;
  portfolioWorkflow: OneKycWorkflow;
  portfolioExportPayloads: NonNullable<
    Parameters<typeof OneKycClientZkService.buildDraft>[0]["exportPayloads"]
  >;
}> {
  const portfolioWorkflow = PORTFOLIO_WORKFLOW;
  const portfolioExportPayloads = [
    {
      scope: portfolioWorkflow.requested_scope,
      payload: PORTFOLIO_EXPORT_PAYLOAD as Record<string, unknown>,
    },
  ];

  const builtDraft = await OneKycClientZkService.buildDraft({
    workflow: portfolioWorkflow,
    exportPayloads: portfolioExportPayloads,
  });

  // Sanity: the first draft itself must have a holdings <th> table.
  // If this fails, the fixture is broken and the subsequent tests are meaningless.
  if (!builtDraft.htmlBody.includes("<th")) {
    throw new Error(
      "Portfolio fixture is broken: buildDraft did not produce a holdings <th> table. " +
        "Check PORTFOLIO_EXPORT_PAYLOAD and formatPortfolioApprovedValue."
    );
  }

  // Verify each individual holding value is present in the body (confirms the hardcoded
  // values match what the renderer actually produces).
  for (const [key, value] of Object.entries(PORTFOLIO_HOLDING_APPROVED_VALUES)) {
    if (!builtDraft.body.includes(value)) {
      throw new Error(
        `Portfolio fixture: holding value for "${key}" not found in draft body. ` +
          `Expected "${value}" to appear in the body produced by formatHoldingLine.`
      );
    }
  }

  // Override approvedValues so each holding line is a separate token. This leaves
  // "Holdings\n" as literal structural text in the tokenized template, enabling the
  // structure-loss test to strip it with tokenized.replace(/Holdings\n/g, "") while
  // preserving all {{Fn}} tokens (token-integrity still passes).
  const portfolioLocalDraft = {
    ...builtDraft,
    approvedValues: PORTFOLIO_HOLDING_APPROVED_VALUES,
  };

  return { portfolioLocalDraft, portfolioWorkflow, portfolioExportPayloads };
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

  it("redraft htmlBody preserves the holdings table (parity with first draft)", async () => {
    const { portfolioLocalDraft, portfolioWorkflow, portfolioExportPayloads } =
      await makePortfolioFixture();

    // The portfolioLocalDraft uses individual holding values as approvedValues (not the
    // whole financial block). The FIELD_SET_CHANGED re-validation inside runLlmRedraft
    // calls buildDraft which would otherwise return a different key set. Mock it to
    // return the same fixture so the key-set check passes.
    vi.spyOn(OneKycClientZkService, "buildDraft").mockResolvedValueOnce(portfolioLocalDraft);

    const result = await runLlmRedraft({
      localDraft: portfolioLocalDraft,
      instruction: "make it more concise",
      workflow: portfolioWorkflow,
      exportPayloads: portfolioExportPayloads,
      llmRewrite: async (tokenized) => tokenized, // echo: preserves tokens + structure
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // `<th` is emitted ONLY by the holdings table (htmlTable). The shell's
      // presentation table and htmlList cards use `<td>`, so `<th` is the
      // reliable "holdings table rendered" marker — NOT `<table`.
      expect(result.draft.htmlBody).toContain("<th");
    }
  });

  it("empty LLM response fails closed with LLM_EMPTY", async () => {
    const { portfolioLocalDraft, portfolioWorkflow, portfolioExportPayloads } =
      await makePortfolioFixture();

    // LLM_EMPTY fires before the FIELD_SET_CHANGED re-validation — no buildDraft mock needed.
    const result = await runLlmRedraft({
      localDraft: portfolioLocalDraft,
      instruction: "make it more concise",
      workflow: portfolioWorkflow,
      exportPayloads: portfolioExportPayloads,
      llmRewrite: async () => "",
    });
    expect(result).toEqual({ ok: false, errorCode: "LLM_EMPTY" });
  });

  it("structure loss falls back to the deterministic structured draft", async () => {
    const { portfolioLocalDraft, portfolioWorkflow, portfolioExportPayloads } =
      await makePortfolioFixture();

    // The portfolioLocalDraft uses individual holding values as approvedValues. The
    // re-validation buildDraft call inside runLlmRedraft must return the same fixture
    // so the FIELD_SET_CHANGED key-set check passes and execution reaches the
    // structure-loss check. The mocked revalidatedDraft (= portfolioLocalDraft) is also
    // what gets returned as result.draft when the fallback fires, so its htmlBody (with
    // <th>) is what we assert against.
    vi.spyOn(OneKycClientZkService, "buildDraft").mockResolvedValueOnce(portfolioLocalDraft);

    const result = await runLlmRedraft({
      localDraft: portfolioLocalDraft,
      instruction: "summarize",
      workflow: portfolioWorkflow,
      exportPayloads: portfolioExportPayloads,
      // Drop the Holdings block markers so the redraft can no longer form a table,
      // but keep every token so token-integrity still passes.
      llmRewrite: async (tokenized) => tokenized.replace(/Holdings\n/g, ""),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.structureFallback).toBe(true);
      expect(result.draft.htmlBody).toContain("<th"); // deterministic draft restored
    }
  });
});
