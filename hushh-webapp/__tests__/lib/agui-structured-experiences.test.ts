import { describe, expect, it } from "vitest";

import {
  parseAgentActivityExperience,
  parseAgentToolResultExperience,
} from "@/lib/agent/agui-structured-experiences";

const scopeResult = {
  status: "ok",
  person: {
    displayName: "Alex Morgan",
    personRef: "not-for-display",
    profilePath: "/people/1234567890abcdef",
    relationship: "connected",
  },
  domainFilter: "Identity",
  requestableScopes: [
    {
      scopeRef: "opaque-scope-ref",
      label: "Employment status",
      description: "Current employment eligibility status.",
      domain: "Identity",
      sensitivity: "high",
    },
  ],
};

describe("AG-UI structured experience registry", () => {
  it("accepts the versioned scope activity and normalizes its bounded fields", () => {
    expect(
      parseAgentActivityExperience("one.scope_discovery.v1", scopeResult),
    ).toEqual({
      type: "one.scope_discovery.v1",
      person: {
        displayName: "Alex Morgan",
        profilePath: "/people/1234567890abcdef",
        relationship: "connected",
      },
      domainFilter: "Identity",
      scopes: [
        {
          scopeRef: "opaque-scope-ref",
          label: "Employment status",
          description: "Current employment eligibility status.",
          domain: "Identity",
          sensitivity: "restricted",
        },
      ],
    });
  });

  it("adapts the existing ADK tool result into the same app-owned registry", () => {
    expect(
      parseAgentToolResultExperience(
        "discover_person_information",
        JSON.stringify(scopeResult),
      ),
    ).toMatchObject({ type: "one.scope_discovery.v1" });
  });

  it("fails closed for unknown types, invalid routes, and unrelated tools", () => {
    expect(parseAgentActivityExperience("model.react.v1", scopeResult)).toBeNull();
    expect(
      parseAgentToolResultExperience("unknown_tool", scopeResult),
    ).toBeNull();
    expect(
      parseAgentToolResultExperience("discover_person_information", {
        ...scopeResult,
        person: { ...scopeResult.person, profilePath: "https://attacker.example" },
      }),
    ).toBeNull();
  });

  it("accepts only complete, versioned Morphy experience payloads", () => {
    expect(parseAgentActivityExperience("one.information_request_review.v1", {
      personName: "Alex Morgan",
      purpose: "Complete payroll onboarding",
      durationLabel: "30 days",
      status: "awaiting_review",
      fields: [{ label: "Work authorization", domain: "Identity", sensitivity: "restricted" }],
    })).toMatchObject({ type: "one.information_request_review.v1", status: "awaiting_review" });

    expect(parseAgentActivityExperience("one.kyc_readiness.v1", {
      subjectName: "Alex Morgan",
      workflowName: "Payroll readiness",
      summary: "Two items require review.",
      legalReviewRequired: true,
      items: [{ label: "Tax identifier", domain: "Identity", sensitivity: "high", status: "ask_first" }],
    })).toMatchObject({ type: "one.kyc_readiness.v1", legalReviewRequired: true });

    expect(parseAgentActivityExperience("one.memory_import_review.v1", {
      sourceBlockCount: 12,
      accountedBlockCount: 12,
      groups: [{ domain: "Professional", candidates: [{ candidateRef: "candidate-1", label: "Role", preview: "Product lead", sensitivity: "standard", sharingPosture: "private" }] }],
    })).toMatchObject({ type: "one.memory_import_review.v1", accountedBlockCount: 12 });

    expect(parseAgentActivityExperience("one.evidence_brief.v1", {
      title: "Verification summary",
      summary: "The available evidence supports the primary claim.",
      confidence: "high",
      findings: [{ label: "Source alignment", detail: "Two independent records agree." }],
      sources: [{ label: "Primary record", url: "https://example.com/evidence" }],
      unresolved: [],
    })).toMatchObject({ type: "one.evidence_brief.v1", confidence: "high" });
  });

  it("rejects unsafe evidence links and incomplete memory coverage shapes", () => {
    const evidence = parseAgentActivityExperience("one.evidence_brief.v1", {
      title: "Verification summary",
      summary: "A bounded summary.",
      confidence: "medium",
      findings: [],
      sources: [{ label: "Unsafe", url: "javascript:alert(1)" }],
      unresolved: [],
    });
    expect(evidence).toMatchObject({ sources: [] });
    expect(parseAgentActivityExperience("one.memory_import_review.v1", {
      sourceBlockCount: 2,
      accountedBlockCount: 3,
      groups: [],
    })).toBeNull();
  });
});
