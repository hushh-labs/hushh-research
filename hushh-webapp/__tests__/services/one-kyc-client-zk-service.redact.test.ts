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
  htmlFromPlaintext,
  isKeywordOnlyInstruction,
  redactDraftForLlm,
  resubstituteDraft,
  validateTokenIntegrity,
} from "@/lib/services/one-kyc-client-zk-service";

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

describe("htmlFromPlaintext", () => {
  it("escapes all HTML-significant characters", () => {
    const html = htmlFromPlaintext("Hello <b> & 'you' \"q\"");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&quot;");
    // No raw special characters survive inside the text content.
    expect(html).not.toContain("<b>");
    expect(html).not.toMatch(/ & /);
  });

  it("does not double-escape ampersands", () => {
    const html = htmlFromPlaintext("a & <b>");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("&amp;amp;");
    expect(html).not.toContain("&amp;lt;");
  });

  it("splits double newlines into separate paragraph blocks", () => {
    const html = htmlFromPlaintext("Line1\n\nLine2");
    const paragraphCount = (html.match(/<p /g) || []).length;
    expect(paragraphCount).toBe(2);
    expect(html).toContain("Line1");
    expect(html).toContain("Line2");
  });

  it("converts single newlines to <br/> within a paragraph", () => {
    const html = htmlFromPlaintext("Line1\nLine2");
    const paragraphCount = (html.match(/<p /g) || []).length;
    expect(paragraphCount).toBe(1);
    expect(html).toContain("Line1<br/>Line2");
  });
});
