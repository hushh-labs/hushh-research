import { describe, expect, it } from "vitest";

import {
  buildKycWorkflowArtifact,
  mergeKycWorkflowArtifact,
  type KycWorkflowArtifact,
  type KycWorkflowCheck,
} from "@/lib/services/kyc-pkm-write-service";

/**
 * Characterization specs for the public nested-configuration merge surface.
 *
 * TRUTH-FIRST NOTE ON SURFACE SELECTION
 * -------------------------------------
 * The task framed this as a "public preference updater" that deep-merges a
 * partial nested dictionary against an existing configuration map. The repo
 * does NOT expose a standalone `updatePreference`/`deepMerge` utility:
 *   - `PersonalKnowledgeModelService.deepMergeRecords` exists but is
 *     `private static` and therefore not importable / not a public contract.
 *   - `KaiProfileService` preference updates are async class methods bound to
 *     vault persistence + PkmWriteCoordinator, not pure importable mergers.
 *
 * The load-bearing PUBLIC pure merge that takes an incoming nested config map
 * and reconciles it against an existing one — preserving unmentioned sibling
 * properties — is `mergeKycWorkflowArtifact` in
 * `hushh-webapp/lib/services/kyc-pkm-write-service.ts`. These specs
 * characterize its observed merge behavior; they do not assert an invented
 * "deep-merge-everything" contract, because the real function merges with
 * documented, field-specific rules (see below).
 *
 * TRUTH-FIRST NOTE ON FILE NAME
 * -----------------------------
 * The task requested a ".spec.ts" file, but hushh-webapp/vitest.config.ts
 * only collects test files whose names end in ".test.ts" / ".test.tsx". A
 * ".spec.ts" file is silently ignored by both the local runner and CI, which
 * would make any "verified" claim false. This file therefore uses the
 * ".test.ts" extension so it is actually collected and executed.
 *
 * OBSERVED MERGE RULES (from source, not assumption):
 *   - `checks.<key>`: incoming wins UNLESS incoming status is "not_started",
 *     in which case the existing check is preserved (per-check fallback merge).
 *   - `counterparty` / `request_summary`: incoming ?? existing ?? null.
 *   - `overall_status`, `pending_requirements`, `completed_requirements`:
 *     taken verbatim from the incoming artifact (replace semantics).
 *   - `sent_replies`: shallow dictionary union (existing ∪ incoming), with
 *     incoming keys overriding existing keys, dropped to `undefined` if empty.
 */

function check(overrides: Partial<KycWorkflowCheck> = {}): KycWorkflowCheck {
  return {
    status: "not_started",
    updated_at: null,
    method: null,
    source_domain: null,
    ...overrides,
  };
}

function existingArtifact(): KycWorkflowArtifact {
  return buildKycWorkflowArtifact(
    {
      checks: {
        identity: check({ status: "verified", method: "doc_scan", updated_at: "2024-01-01T00:00:00.000Z" }),
        address: check({ status: "verified", method: "utility_bill" }),
        bank: check({ status: "pending" }),
        email: check({ status: "verified", method: "otp" }),
      },
      overall_status: "pending",
      counterparty: "Acme Capital",
      request_summary: "Full KYC onboarding",
      pending_requirements: ["bank"],
      completed_requirements: ["identity", "address", "email"],
      sent_replies: {
        "wf-1": {
          workflow_id: "wf-1",
          subject: "Welcome",
          body: "hello",
          html_body: null,
          to: ["user@example.com"],
          cc: [],
          sent_at: "2024-01-01T00:00:00.000Z",
          draft_hash: null,
          schema_version: 1,
        },
      },
    },
    "2024-01-01T00:00:00.000Z"
  );
}

describe("mergeKycWorkflowArtifact — nested configuration merge integrity", () => {
  it("preserves unmentioned sibling checks when incoming leaves them not_started", () => {
    const existing = existingArtifact();

    // Incoming only meaningfully updates the `bank` check; siblings arrive as
    // the default "not_started" partial payload.
    const incoming = buildKycWorkflowArtifact(
      {
        checks: {
          identity: check(),
          address: check(),
          bank: check({ status: "verified", method: "plaid" }),
          email: check(),
        },
        overall_status: "verified",
        counterparty: null,
        request_summary: null,
        pending_requirements: [],
        completed_requirements: ["identity", "address", "email", "bank"],
      },
      "2024-02-01T00:00:00.000Z"
    );

    const merged = mergeKycWorkflowArtifact(incoming, existing);

    // Sibling checks are NOT wiped: the previously-verified checks survive.
    expect(merged.checks.identity.status).toBe("verified");
    expect(merged.checks.identity.method).toBe("doc_scan");
    expect(merged.checks.address.status).toBe("verified");
    expect(merged.checks.email.status).toBe("verified");

    // The explicitly-updated check takes the incoming value.
    expect(merged.checks.bank.status).toBe("verified");
    expect(merged.checks.bank.method).toBe("plaid");
  });

  it("lets a meaningful incoming check override the existing sibling", () => {
    const existing = existingArtifact();
    const incoming = buildKycWorkflowArtifact(
      {
        checks: {
          identity: check({ status: "failed", method: "manual_review" }),
          address: check(),
          bank: check(),
          email: check(),
        },
        overall_status: "failed",
        counterparty: null,
        request_summary: null,
        pending_requirements: ["identity"],
        completed_requirements: [],
      },
      "2024-03-01T00:00:00.000Z"
    );

    const merged = mergeKycWorkflowArtifact(incoming, existing);

    // Non-"not_started" incoming status replaces the existing check entirely.
    expect(merged.checks.identity.status).toBe("failed");
    expect(merged.checks.identity.method).toBe("manual_review");
    // Untouched siblings are still preserved.
    expect(merged.checks.address.status).toBe("verified");
  });

  it("falls back to existing scalar config when incoming omits it (null)", () => {
    const existing = existingArtifact();
    const incoming = buildKycWorkflowArtifact(
      {
        checks: {
          identity: check(),
          address: check(),
          bank: check(),
          email: check(),
        },
        overall_status: "pending",
        counterparty: null,
        request_summary: null,
        pending_requirements: ["bank"],
        completed_requirements: ["identity", "address", "email"],
      },
      "2024-04-01T00:00:00.000Z"
    );

    const merged = mergeKycWorkflowArtifact(incoming, existing);

    // Unmentioned scalar siblings resolve incoming ?? existing.
    expect(merged.counterparty).toBe("Acme Capital");
    expect(merged.request_summary).toBe("Full KYC onboarding");
  });

  it("performs a dictionary union over sent_replies, preserving prior entries", () => {
    const existing = existingArtifact();
    const incoming = buildKycWorkflowArtifact(
      {
        checks: {
          identity: check(),
          address: check(),
          bank: check(),
          email: check(),
        },
        overall_status: "pending",
        counterparty: null,
        request_summary: null,
        pending_requirements: [],
        completed_requirements: [],
        sent_replies: {
          "wf-2": {
            workflow_id: "wf-2",
            subject: "Follow up",
            body: "second",
            html_body: null,
            to: ["user@example.com"],
            cc: [],
            sent_at: "2024-05-01T00:00:00.000Z",
            draft_hash: null,
            schema_version: 1,
          },
        },
      },
      "2024-05-01T00:00:00.000Z"
    );

    const merged = mergeKycWorkflowArtifact(incoming, existing);

    // Both the pre-existing and the incoming reply keys coexist.
    expect(Object.keys(merged.sent_replies || {}).sort()).toEqual(["wf-1", "wf-2"]);
    expect(merged.sent_replies?.["wf-1"]?.subject).toBe("Welcome");
    expect(merged.sent_replies?.["wf-2"]?.subject).toBe("Follow up");
  });

  it("takes list-shaped config verbatim from the incoming payload (replace, not append)", () => {
    const existing = existingArtifact();
    const incoming = buildKycWorkflowArtifact(
      {
        checks: {
          identity: check(),
          address: check(),
          bank: check({ status: "verified" }),
          email: check(),
        },
        overall_status: "verified",
        counterparty: null,
        request_summary: null,
        pending_requirements: [],
        completed_requirements: ["identity", "address", "email", "bank"],
      },
      "2024-06-01T00:00:00.000Z"
    );

    const merged = mergeKycWorkflowArtifact(incoming, existing);

    // Array requirement lists are replaced by the incoming values.
    expect(merged.pending_requirements).toEqual([]);
    expect(merged.completed_requirements).toEqual(["identity", "address", "email", "bank"]);
    expect(merged.overall_status).toBe("verified");
  });

  it("treats a null existing map as a pure adoption of the incoming config", () => {
    const incoming = existingArtifact();

    const merged = mergeKycWorkflowArtifact(incoming, null);

    expect(merged.checks.identity.status).toBe("verified");
    expect(merged.counterparty).toBe("Acme Capital");
    expect(Object.keys(merged.sent_replies || {})).toEqual(["wf-1"]);
    expect(merged.schema_version).toBe(1);
  });

  it("does not mutate the existing configuration map in place", () => {
    const existing = existingArtifact();
    const snapshot = JSON.stringify(existing);

    const incoming = buildKycWorkflowArtifact(
      {
        checks: {
          identity: check({ status: "failed" }),
          address: check(),
          bank: check(),
          email: check(),
        },
        overall_status: "failed",
        counterparty: "New Corp",
        request_summary: "Re-verification",
        pending_requirements: ["identity"],
        completed_requirements: [],
      },
      "2024-07-01T00:00:00.000Z"
    );

    mergeKycWorkflowArtifact(incoming, existing);

    // The existing object is untouched — merge produces a fresh artifact.
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});
