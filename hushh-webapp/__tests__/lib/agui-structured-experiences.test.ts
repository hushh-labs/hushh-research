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
  it("keeps explicit catalog continuation and flags oversized legacy snapshots", () => {
    const result = parseAgentToolResultExperience("discover_person_information", {
      ...scopeResult,
      scopeCatalog: { page: 1, limit: 100, totalCount: 601, nextPage: 2, hasMore: true,
        catalogRevision: "a".repeat(64), paginationReset: false,
        domains: [{ domain: "professional", count: 601 }] },
    });
    expect(result).toMatchObject({ scopeCatalog: { totalCount: 601, nextPage: 2 } });
    const legacy = parseAgentToolResultExperience("discover_person_information", {
      ...scopeResult, requestableScopes: Array.from({ length: 501 }, (_, index) => ({
        ...scopeResult.requestableScopes[0], scopeRef: `synthetic-${index}`,
      })),
    });
    expect(legacy).toMatchObject({ catalogIncomplete: true });
  });
  it("parses server-issued person choices without accepting arbitrary profile links", () => {
    const candidate = { selectionHandle: "a".repeat(32), displayName: "Alex Morgan",
      profilePath: "/people/1234567890abcdef", detail: "a***@example.test" };
    const result = parseAgentToolResultExperience("discover_person_information", {
      status: "needs_clarification", candidates: [candidate,
        { ...candidate, profilePath: "https://example.test" },
        { ...candidate, selectionHandle: "forged" }],
    });
    expect(result).toEqual({ type: "one.person_selection.v1", candidates: [candidate] });
  });
  it("preserves an incomplete candidate signal for the picker", () => {
    const candidate = {
      selectionHandle: "c".repeat(32),
      displayName: "Alex Morgan",
      profilePath: "/people/1234567890abcdef",
      detail: null,
    };
    expect(
      parseAgentToolResultExperience("discover_person_information", {
        status: "needs_clarification",
        candidates: [candidate],
        candidatesIncomplete: true,
      }),
    ).toEqual({
      type: "one.person_selection.v1",
      candidates: [candidate],
      candidatesIncomplete: true,
    });
  });
  it("keeps person choices visible when shared-information listing needs clarification", () => {
    const candidate = {
      selectionHandle: "b".repeat(32),
      displayName: "Alex Morgan",
      profilePath: "/people/1234567890abcdef",
      detail: "a***@example.test",
    };
    expect(
      parseAgentToolResultExperience("list_information_shared_with_me", {
        status: "needs_clarification",
        candidates: [candidate],
      }),
    ).toEqual({ type: "one.person_selection.v1", candidates: [candidate] });
  });
  it("turns a consent proposal into the Profile-aligned review card", () => {
    expect(
      parseAgentToolResultExperience("propose_information_request", {
        status: "proposal_ready",
        proposalId: "must-not-render",
        person: { displayName: "Alex Morgan", profilePath: "/people/1234567890abcdef" },
        fields: ["Employment status", "Company name"],
        purpose: "Complete the onboarding review.",
        durationHours: 48,
      }),
    ).toEqual({
      type: "one.information_request_review.v1",
      personName: "Alex Morgan",
      purpose: "Complete the onboarding review.",
      durationLabel: "2 days",
      direction: "outgoing",
      phase: "draft",
      subjectRef: null,
      bundleId: null,
      requestId: null,
      status: "awaiting_review",
      fields: [
        { label: "Employment status", domain: "Information", sensitivity: "standard" },
        { label: "Company name", domain: "Information", sensitivity: "standard" },
      ],
    });
  });
  it("keeps restored request direction explicit and accepts terminal lifecycle states", () => {
    const result = parseAgentActivityExperience("one.information_request_review.v1", {
      direction: "outgoing",
      phase: "submitted",
      subjectRef: "person_1234567890123456",
      bundleId: "bundle_12345678",
      requestId: "request_12345678",
      personName: "Alex Morgan",
      purpose: "Complete payroll onboarding",
      durationLabel: "30 days",
      status: "revoked",
      fields: [{ label: "Work authorization", domain: "Identity", sensitivity: "high" }],
    });
    expect(result).toMatchObject({
      direction: "outgoing",
      phase: "submitted",
      subjectRef: "person_1234567890123456",
      bundleId: "bundle_12345678",
      requestId: "request_12345678",
      status: "revoked",
    });
  });
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
    })).toMatchObject({ type: "one.memory_import_review.v1", accountedBlockCount: 12, presentationIncomplete: false });

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

  it("marks dropped memory review rows as incomplete instead of claiming full coverage", () => {
    const result = parseAgentActivityExperience("one.memory_import_review.v1", {
      sourceBlockCount: 1,
      accountedBlockCount: 1,
      groups: [{
        domain: "Professional",
        candidates: [
          { candidateRef: "candidate-1", label: "Role", preview: "Product lead", sharingPosture: "private" },
          { candidateRef: "candidate-1", label: "Duplicate", preview: "Must not be silently merged", sharingPosture: "private" },
          { candidateRef: "candidate-2", label: "Malformed", preview: "", sharingPosture: "private" },
        ],
      }],
    });

    expect(result).toMatchObject({ presentationIncomplete: true });
  });

  it("marks truncated memory groups and candidates as incomplete", () => {
    const groups = Array.from({ length: 51 }, (_, index) => ({
      domain: `Domain ${index}`,
      candidates: [{ candidateRef: `candidate-${index}`, label: "Role", preview: "Lead", sharingPosture: "private" }],
    }));
    const result = parseAgentActivityExperience("one.memory_import_review.v1", {
      sourceBlockCount: 1,
      accountedBlockCount: 1,
      groups,
    });

    expect(result).toMatchObject({ presentationIncomplete: true });
  });
});
