import { describe, expect, it } from "vitest";

import {
  isKycClientDraftReady,
  removeKycWorkflowLocalState,
  retainReadyKycWorkflowLocalState,
  selectedScopesForWorkflow,
} from "@/lib/one-kyc/workflow-state";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

function workflow(overrides: Partial<OneKycWorkflow> = {}): OneKycWorkflow {
  return {
    workflow_id: "wf_1",
    user_id: "user_1",
    status: "waiting_on_user",
    participant_emails: ["broker@example.com"],
    required_fields: ["full_name"],
    draft_status: "ready",
    ...overrides,
  };
}

describe("one KYC workflow state helpers", () => {
  it("keeps selected multi-scope workflow consent inside the workflow boundary", () => {
    const current = workflow({
      requested_scope: "attr.identity.*",
      requested_scopes: ["attr.identity.*", "attr.financial.*"],
      metadata: {
        candidate_scopes: [
          { scope: "attr.identity.*", domain: "identity", label: "Identity" },
          { scope: "attr.financial.*", domain: "financial", label: "Financial" },
        ],
      },
    });

    expect(selectedScopesForWorkflow(current, {})).toEqual([
      "attr.identity.*",
      "attr.financial.*",
    ]);
    expect(selectedScopesForWorkflow(current, { wf_1: ["attr.identity.*"] })).toEqual([
      "attr.identity.*",
    ]);
  });

  it("drops local decrypted draft state once a workflow leaves ready review", () => {
    const ready = workflow({ workflow_id: "ready" });
    const sent = workflow({
      workflow_id: "sent",
      status: "waiting_on_counterparty",
      draft_status: "sent",
    });
    const blocked = workflow({
      workflow_id: "blocked",
      status: "blocked",
      draft_status: "rejected",
    });

    expect(isKycClientDraftReady(ready)).toBe(true);
    expect(isKycClientDraftReady(sent)).toBe(false);
    expect(
      retainReadyKycWorkflowLocalState(
        { ready: "draft", sent: "draft", blocked: "draft" },
        [ready, sent, blocked]
      )
    ).toEqual({ ready: "draft" });
  });

  it("removes one workflow cache without disturbing other ready drafts", () => {
    expect(removeKycWorkflowLocalState({ wf_1: "draft", wf_2: "draft" }, "wf_1")).toEqual({
      wf_2: "draft",
    });
  });
});
