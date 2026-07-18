import { describe, expect, it } from "vitest";

import { selectedScopeLabels } from "@/lib/one-kyc/workflow-state";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

// ─────────────────────────────────────────────────────────────────────────────
// friendlyScopeLabel (private) — characterization tests via selectedScopeLabels
//
// Implementation boundary (private function in workflow-state.ts):
//
//   function friendlyScopeLabel(scope: string): string {
//     const parts = scope
//       .split(".")
//       .map((part) => part.trim())
//       .filter(Boolean)
//       .filter((part) => part !== "attr" && part !== "*");
//     if (!parts.length) return "Selected data";
//     const text = parts.join(" ").replaceAll("_", " ");
//     return `${text.charAt(0).toUpperCase()}${text.slice(1)} data`;
//   }
//
// Exact transform pipeline:
//   1. split(".")              — tokenise by dot
//   2. map(trim)               — strip whitespace
//   3. filter(Boolean)         — remove empty tokens
//   4. filter(!= "attr", "!")  — remove the two reserved filter tokens
//   5. parts.length === 0      → "Selected data"  (fallback)
//   6. join(" ")               — space-separated
//   7. replaceAll("_", " ")    — underscores → spaces
//   8. capitalize first char + append " data"
//
// Access path through exported API:
//   selectedScopeLabels(workflow)
//     → scopeCandidates(workflow)       uses workflow.candidate_scopes when set
//     → selectedScopesForWorkflow(w,{}) uses workflow.selected_scopes when set
//     → candidate.label || friendlyScopeLabel(candidate.scope)
//
// Each test workflow omits the optional `label` field on its candidate so that
// the `|| friendlyScopeLabel(...)` branch is always exercised.
//
// import type is erased at runtime — no side-effects from one-kyc-service.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the minimal OneKycWorkflow that routes selectedScopeLabels directly
 * through friendlyScopeLabel for the given scope string.
 *
 * - candidate_scopes set      → scopeCandidates() returns it directly
 * - selected_scopes set       → selectedScopesForWorkflow(w, {}) returns it directly
 * - no label on candidate     → falls to friendlyScopeLabel(candidate.scope)
 */
function makeWorkflow(scope: string): OneKycWorkflow {
  return {
    workflow_id: "wf-label-test",
    user_id: null,
    status: "waiting_on_user",
    participant_emails: [],
    required_fields: [],
    candidate_scopes: [{ scope, domain: "identity" }], // no label field
    selected_scopes: [scope],
  };
}

describe("friendlyScopeLabel (via selectedScopeLabels) — normal scope formatting", () => {
  it("joins dot-separated parts with a space and capitalizes the first char", () => {
    // "vault.owner" → parts: ["vault","owner"] → text: "vault owner" → "Vault owner data"
    expect(selectedScopeLabels(makeWorkflow("vault.owner"))).toEqual(["Vault owner data"]);
  });

  it("handles a two-part scope with an underscore in one part", () => {
    // "pkm.read" → parts: ["pkm","read"] → text: "pkm read" → "Pkm read data"
    expect(selectedScopeLabels(makeWorkflow("pkm.read"))).toEqual(["Pkm read data"]);
  });

  it("handles a three-part scope", () => {
    // "identity.document.scan" → parts: ["identity","document","scan"]
    // text: "identity document scan" → "Identity document scan data"
    expect(selectedScopeLabels(makeWorkflow("identity.document.scan"))).toEqual([
      "Identity document scan data",
    ]);
  });
});

describe("friendlyScopeLabel — 'attr' segment filtering", () => {
  it("removes the 'attr' segment before joining", () => {
    // "attr.identity_score" → filter removes "attr" → parts: ["identity_score"]
    // replaceAll: "identity score" → "Identity score data"
    expect(selectedScopeLabels(makeWorkflow("attr.identity_score"))).toEqual([
      "Identity score data",
    ]);
  });

  it("removes the 'attr' segment when it is the sole part — falls back to 'Selected data'", () => {
    // "attr" → filter removes "attr" → parts: [] → "Selected data"
    expect(selectedScopeLabels(makeWorkflow("attr"))).toEqual(["Selected data"]);
  });
});

describe("friendlyScopeLabel — '*' wildcard segment filtering", () => {
  it("removes the '*' wildcard segment before joining", () => {
    // "pkm.*" → filter removes "*" → parts: ["pkm"] → "Pkm data"
    expect(selectedScopeLabels(makeWorkflow("pkm.*"))).toEqual(["Pkm data"]);
  });

  it("returns 'Selected data' when both 'attr' and '*' are filtered (attr.* scope)", () => {
    // "attr.*" → filter removes "attr", then "*" → parts: [] → "Selected data"
    expect(selectedScopeLabels(makeWorkflow("attr.*"))).toEqual(["Selected data"]);
  });
});

describe("friendlyScopeLabel — underscore replacement", () => {
  it("replaces ALL underscores with spaces in a bare (no-dot) scope", () => {
    // "financial_data" → parts: ["financial_data"] → text: "financial data"
    // Appends " data" → "Financial data data"
    // This documents the exact behavior: the " data" suffix is ALWAYS appended,
    // even when the scope word itself already ends with "_data".
    expect(selectedScopeLabels(makeWorkflow("financial_data"))).toEqual([
      "Financial data data",
    ]);
  });

  it("replaces underscores in an attr-filtered scope part", () => {
    // "attr.tax_return" → filter removes "attr" → ["tax_return"]
    // replaceAll → "tax return" → "Tax return data"
    expect(selectedScopeLabels(makeWorkflow("attr.tax_return"))).toEqual(["Tax return data"]);
  });
});

describe("friendlyScopeLabel — 'Selected data' fallback (all parts filtered)", () => {
  it("returns 'Selected data' for a scope of exactly '*'", () => {
    // "*" → filter removes "*" → parts: [] → fallback
    expect(selectedScopeLabels(makeWorkflow("*"))).toEqual(["Selected data"]);
  });
});