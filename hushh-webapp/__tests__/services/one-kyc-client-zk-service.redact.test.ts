import { describe, expect, it, vi } from "vitest";

// The module under test imports OneKycService and PKM services at module load.
// Mock them so the pure redact/refill helpers can be imported in isolation.
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
  isKeywordOnlyInstruction,
  OneKycClientZkService,
  reassembleDraftTemplate,
  redactDraftForLlm,
  resubstituteDraft,
  splitDraftTemplate,
  validateTokenIntegrity,
} from "@/lib/services/one-kyc-client-zk-service";
import type { KycDraftRenderModel } from "@/lib/services/one-kyc-client-zk-service";
import { APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID } from "@/lib/services/one-kyc-approved-disclosure-renderer";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

// Minimal render-model fixture: splitDraftTemplate only reads style.formal and
// accountHolder to recompute the deterministic opening line.
function makeRenderModel(params: {
  accountHolder: string;
  formal?: boolean;
}): KycDraftRenderModel {
  return {
    contractId: APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
    contractVersion: "1.0.0",
    accountHolder: params.accountHolder,
    style: {
      compact: false,
      formal: Boolean(params.formal),
      bulletList: false,
      structured: false,
      table: false,
      fullDetail: false,
      human: false,
      cleanHeaders: false,
    },
    sections: [],
    missingFields: [],
  };
}

describe("redactDraftForLlm", () => {
  it("replaces every approved value with an opaque token and leaves no real value", () => {
    const { tokenizedTemplate, tokenMap } = redactDraftForLlm({
      body: "Dear Jane Doe, your DOB is 1990-01-01",
      approvedValues: { full_name: "Jane Doe", date_of_birth: "1990-01-01" },
    });
    expect(tokenMap).toEqual({ F0: "Jane Doe", F1: "1990-01-01" });
    expect(tokenizedTemplate).toBe("Dear {{F0}}, your DOB is {{F1}}");
    expect(tokenizedTemplate).not.toContain("Jane Doe");
    expect(tokenizedTemplate).not.toContain("1990-01-01");
  });

  it("creates a tokenMap entry even when a value does not appear in the body (map-driven)", () => {
    const { tokenMap } = redactDraftForLlm({
      body: "Dear Jane Doe",
      approvedValues: { full_name: "Jane Doe", phone: "555-1234" },
    });
    expect(tokenMap).toEqual({ F0: "Jane Doe", F1: "555-1234" });
  });

  it("substitutes longest values first to avoid partial-match shadowing", () => {
    const { tokenizedTemplate } = redactDraftForLlm({
      body: "Name: Jane Doe. First: Jane.",
      approvedValues: { full_name: "Jane Doe", first_name: "Jane" },
    });
    // "Jane Doe" tokenized as a whole, standalone "Jane" tokenized separately.
    expect(tokenizedTemplate).toBe("Name: {{F0}}. First: {{F1}}.");
  });

  it("removes overlapping values without leaving either verbatim", () => {
    const { tokenizedTemplate } = redactDraftForLlm({
      body: "AAA and AAAB",
      approvedValues: { short: "AAA", long: "AAAB" },
    });
    expect(tokenizedTemplate).not.toContain("AAA");
    expect(tokenizedTemplate).not.toContain("AAAB");
  });

  it("throws KYC redact incomplete when a value is re-introduced by token substitution", () => {
    // Genuine leak: tokenizing "abc" inserts "{{F1}}". A second value literally equal
    // to "{{F1}}" then matches that inserted token text, but its own substitution
    // ("{{F0}}") is processed first (longer value first) and afterwards the inserted
    // "{{F1}}" from the "abc" replacement re-surfaces value F0's text. Construct a case
    // where a real value of length >= 3 provably survives.
    expect(() =>
      redactDraftForLlm({
        // F0 = "{{F1}}" (len 6) replaced first -> body has no "{{F1}}" left.
        // F1 = "abc" replaced next -> inserts "{{F1}}" back into the template, which is
        // exactly the verbatim text of value F0 ("{{F1}}"), so F0's value reappears.
        body: "x {{F1}} y abc z",
        approvedValues: { token_like: "{{F1}}", code: "abc" },
      })
    ).toThrow(/KYC redact incomplete/);
  });
});

describe("resubstituteDraft", () => {
  it("reconstructs the original plaintext exactly", () => {
    expect(
      resubstituteDraft("Dear {{F0}}, DOB {{F1}}", { F0: "Jane Doe", F1: "1990-01-01" })
    ).toBe("Dear Jane Doe, DOB 1990-01-01");
  });

  it("is the exact inverse of redactDraftForLlm (round-trip)", () => {
    const body = "Dear Jane Doe, your DOB is 1990-01-01 and phone 555-9999";
    const approvedValues = {
      full_name: "Jane Doe",
      date_of_birth: "1990-01-01",
      phone: "555-9999",
    };
    const { tokenizedTemplate, tokenMap } = redactDraftForLlm({ body, approvedValues });
    expect(resubstituteDraft(tokenizedTemplate, tokenMap)).toBe(body);
  });

  it("leaves unknown placeholders intact", () => {
    expect(resubstituteDraft("Hello {{F9}}", { F0: "x" })).toBe("Hello {{F9}}");
  });
});

describe("validateTokenIntegrity", () => {
  it("returns true when every token appears exactly once", () => {
    expect(validateTokenIntegrity("Hello {{F0}}", "Hello {{F0}}", { F0: "v" })).toBe(true);
  });

  it("returns false on a duplicated token", () => {
    expect(
      validateTokenIntegrity("Hello {{F0}}", "Hello {{F0}} {{F0}}", { F0: "v" })
    ).toBe(false);
  });

  it("returns false on a dropped token", () => {
    expect(validateTokenIntegrity("Hello {{F0}}", "Hello", { F0: "v" })).toBe(false);
  });

  it("returns false on an invented token", () => {
    expect(
      validateTokenIntegrity("Hello {{F0}}", "Hello {{F0}} {{F1}}", { F0: "v" })
    ).toBe(false);
  });

  it("returns true with multiple tokens each appearing once", () => {
    expect(
      validateTokenIntegrity(
        "{{F0}} {{F1}}",
        "Hi {{F1}}, regards {{F0}}",
        { F0: "a", F1: "b" }
      )
    ).toBe(true);
  });
});

describe("isKeywordOnlyInstruction", () => {
  it("returns true for a pure keyword instruction", () => {
    expect(isKeywordOnlyInstruction("make it shorter")).toBe(true);
  });

  it("returns true for 'bullet list'", () => {
    expect(isKeywordOnlyInstruction("bullet list")).toBe(true);
  });

  it("returns false for a semantic instruction", () => {
    expect(isKeywordOnlyInstruction("rephrase the intro to sound warmer")).toBe(false);
  });

  it("returns false when a keyword and a semantic term are both present", () => {
    expect(isKeywordOnlyInstruction("shorter and warmer")).toBe(false);
  });

  it("returns false for an empty instruction", () => {
    expect(isKeywordOnlyInstruction("")).toBe(false);
    expect(isKeywordOnlyInstruction("   ")).toBe(false);
  });

  it("returns false when no keyword matches", () => {
    expect(isKeywordOnlyInstruction("zorp the florp")).toBe(false);
  });

  it("returns true when two pure-format keywords are combined", () => {
    // "bullet list and more formal" — both bullet and formal are keywords,
    // no semantic-intent term present -> keyword-only (regex path).
    expect(isKeywordOnlyInstruction("bullet list and more formal")).toBe(true);
  });

  // Regression: every one of the 8 keyword-vocabulary classes from
  // redraftTransformFromInstructions must still classify as keyword-only.
  it.each([
    ["compact", "make it shorter"],
    ["formal", "make it more formal"],
    ["bulletList", "use a bullet list"],
    ["structured", "add clean structure"],
    ["table", "put it in a table"],
    ["fullDetail", "include all details"],
    ["human", "make it plain english"],
    ["cleanHeaders", "remove headers"],
  ])("classifies the %s keyword class as keyword-only", (_label, instruction) => {
    expect(isKeywordOnlyInstruction(instruction)).toBe(true);
  });
});

// D-F routing override: the runAction("redraft") routing expression is not exported
// from the React component, so we mirror it here as a pure function and assert its
// behavior directly. `isKeyword === true` => regex path; `false` => LLM path.
function routesToRegex(
  instruction: string,
  useAiRedraft: boolean | null,
): boolean {
  return useAiRedraft === false
    ? true // force regex
    : useAiRedraft === true
      ? false // force LLM
      : isKeywordOnlyInstruction(instruction.trim());
}

describe("redraft routing override (useAiRedraft)", () => {
  it("auto-detect: keyword instruction routes to regex", () => {
    expect(routesToRegex("make it shorter", null)).toBe(true);
  });

  it("auto-detect: semantic instruction routes to LLM", () => {
    expect(routesToRegex("rephrase the intro to sound warmer", null)).toBe(
      false,
    );
  });

  it("force AI: a keyword instruction is pushed onto the LLM path", () => {
    // useAiRedraft=true overrides keyword detection -> not regex -> LLM branch.
    expect(routesToRegex("make it shorter", true)).toBe(false);
  });

  it("force regex: a semantic instruction is pulled back onto the regex path", () => {
    expect(
      routesToRegex("rephrase the intro to sound warmer", false),
    ).toBe(true);
  });
});

describe("consolidated portfolio redaction (ZK)", () => {
  const workflow = {
    id: "wf-zk-1",
    required_fields: ["portfolio"],
    requested_scope: "attr.financial.portfolio.*",
    subject: "Portfolio information",
    metadata: { account_holder_name: "Kushal Trivedi" },
  } as unknown as OneKycWorkflow;

  it("redacts every real figure in a multi-account consolidated portfolio", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload: {
        financial: {
          portfolio: {
            accounts: [
              {
                account_info: { brokerage_name: "Fidelity", account_type: "Individual" },
                account_summary: { ending_value: 100000, cash_balance: 1000 },
                holdings: [{ symbol: "AAPL", quantity: 100, market_value: 15000 }],
              },
              {
                account_info: { brokerage_name: "Schwab", account_type: "IRA" },
                account_summary: { ending_value: 50000, cash_balance: 500 },
                holdings: [{ symbol: "AAPL", quantity: 200, market_value: 30000 }],
              },
            ],
          },
        },
      },
    });

    const { tokenizedTemplate, tokenMap } = redactDraftForLlm({
      body: draft.body,
      approvedValues: draft.approvedValues,
    });

    // Each figure genuinely appears in the consolidated draft body (asserted
    // present), and must NOT survive into the tokenized template (the portfolio
    // is one opaque token). Asserting presence-in-body first makes the
    // absence-in-template assertion meaningful, not vacuous.
    for (const figure of ["150,000.00", "100,000.00", "50,000.00", "45,000.00", "1,500.00"]) {
      expect(draft.body).toContain(figure);
      expect(tokenizedTemplate).not.toContain(figure);
    }

    // Round-trip is exact and integrity holds.
    expect(validateTokenIntegrity(tokenizedTemplate, tokenizedTemplate, tokenMap)).toBe(true);
    expect(resubstituteDraft(tokenizedTemplate, tokenMap)).toBe(draft.body);
  });
});

// NB: the former htmlFromPlaintext renderer (and its tests) was retired — the
// LLM-redraft path now renders through renderLlmRedraftHtml in the approved-
// disclosure renderer (escaping + markdown + shared shell), covered by
// __tests__/services/one-kyc-approved-disclosure-renderer.test.ts.

describe("splitDraftTemplate", () => {
  const OPENING = "I am replying on behalf of Jane Doe.";
  const FORMAL_OPENING =
    "I am replying on behalf of Jane Doe with the approved information below.";
  const SIGNATURE = "Best,\nhussh One";

  it("splits a non-formal draft into opening, content, signature", () => {
    const body = `${OPENING}\n\nHere is the requested information.\n${SIGNATURE}`;
    const result = splitDraftTemplate({
      body,
      renderModel: makeRenderModel({ accountHolder: "Jane Doe" }),
    });
    expect(result.matched).toBe(true);
    expect(result.opening).toBe(OPENING);
    expect(result.signature).toBe(SIGNATURE);
    expect(result.content).toBe("Here is the requested information.");
  });

  it("splits a formal draft using the formal opening line", () => {
    const body = `${FORMAL_OPENING}\n\nSection A\n\nSection B\n${SIGNATURE}`;
    const result = splitDraftTemplate({
      body,
      renderModel: makeRenderModel({ accountHolder: "Jane Doe", formal: true }),
    });
    expect(result.matched).toBe(true);
    expect(result.opening).toBe(FORMAL_OPENING);
    expect(result.content).toBe("Section A\n\nSection B");
    expect(result.signature).toBe(SIGNATURE);
  });

  it("handles the compact branch (opening + content + double-newline + signature)", () => {
    const body = `${OPENING}\n\nThe account holder's full name is Jane Doe.\n\n${SIGNATURE}`;
    const result = splitDraftTemplate({
      body,
      renderModel: makeRenderModel({ accountHolder: "Jane Doe" }),
    });
    expect(result.matched).toBe(true);
    expect(result.content).toBe("The account holder's full name is Jane Doe.");
  });

  it("defensive fallback: returns whole body when opening does not match", () => {
    const body = `Some other opening\n\nContent\n${SIGNATURE}`;
    const result = splitDraftTemplate({
      body,
      renderModel: makeRenderModel({ accountHolder: "Jane Doe" }),
    });
    expect(result.matched).toBe(false);
    expect(result.opening).toBe("");
    expect(result.signature).toBe("");
    expect(result.content).toBe(body);
  });

  it("defensive fallback: returns whole body when signature does not match", () => {
    const body = `${OPENING}\n\nContent\nRegards, someone else`;
    const result = splitDraftTemplate({
      body,
      renderModel: makeRenderModel({ accountHolder: "Jane Doe" }),
    });
    expect(result.matched).toBe(false);
    expect(result.content).toBe(body);
  });
});

describe("template preservation on LLM redraft", () => {
  const SIGNATURE = "Best,\nhussh One";

  it("reassembles a byte-identical opening + signature, rewriting only content", () => {
    const renderModel = makeRenderModel({ accountHolder: "Jane Doe" });
    const opening = "I am replying on behalf of Jane Doe.";
    const originalBody = `${opening}\n\nThe original middle content.\n${SIGNATURE}`;

    // 1. Split off the framing.
    const split = splitDraftTemplate({ body: originalBody, renderModel });
    expect(split.matched).toBe(true);

    // 2. Simulate the LLM rewriting ONLY the content portion.
    const rewrittenContent = "A warmer, friendlier rewrite of the middle.";

    // 3. Reassemble around the preserved framing.
    const finalBody = reassembleDraftTemplate({
      opening: split.opening,
      content: rewrittenContent,
      signature: split.signature,
    });

    // Opening preserved byte-identically.
    expect(finalBody.startsWith(`${opening}\n\n`)).toBe(true);
    // Signature preserved byte-identically.
    expect(finalBody.endsWith(SIGNATURE)).toBe(true);
    // Only the middle changed.
    expect(finalBody).toContain(rewrittenContent);
    expect(finalBody).not.toContain("The original middle content.");
    expect(finalBody).toBe(
      `${opening}\n\n${rewrittenContent}\n\n${SIGNATURE}`,
    );
  });

  it("tokenizes ONLY the content; opening/signature never reach the LLM", () => {
    const renderModel = makeRenderModel({ accountHolder: "Jane Doe" });
    const opening = "I am replying on behalf of Jane Doe.";
    const body = `${opening}\n\nThe holder Jane Doe was born 1990-01-01.\n${SIGNATURE}`;
    const approvedValues = { full_name: "Jane Doe", dob: "1990-01-01" };

    const split = splitDraftTemplate({ body, renderModel });
    const { tokenizedTemplate, tokenMap } = redactDraftForLlm({
      body: split.content,
      approvedValues,
    });

    // Content sent to the LLM is the tokenized middle only — no opening/signature.
    expect(tokenizedTemplate).not.toContain("I am replying on behalf of");
    expect(tokenizedTemplate).not.toContain("hussh One");
    expect(tokenizedTemplate).not.toContain("Jane Doe");
    expect(tokenizedTemplate).not.toContain("1990-01-01");

    // Integrity + re-substitution + reassembly round-trips to a framed body.
    expect(validateTokenIntegrity(tokenizedTemplate, tokenizedTemplate, tokenMap)).toBe(
      true,
    );
    const resubstitutedContent = resubstituteDraft(tokenizedTemplate, tokenMap);
    const finalBody = reassembleDraftTemplate({
      opening: split.opening,
      content: resubstitutedContent,
      signature: split.signature,
    });
    expect(finalBody.startsWith(`${opening}\n\n`)).toBe(true);
    expect(finalBody.endsWith(SIGNATURE)).toBe(true);
    expect(finalBody).toContain("Jane Doe");
  });
});
