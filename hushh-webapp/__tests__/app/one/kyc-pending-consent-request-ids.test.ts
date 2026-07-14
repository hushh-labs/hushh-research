/**
 * Unit tests for the workflowPendingConsentRequestIds logic added in
 * hushh-webapp/app/one/kyc/page.tsx to fix the MIXED-consent-bundle bug.
 *
 * The helper is a private function inside the page module, so these tests
 * replicate the same algorithm against the public OneKycWorkflow type.
 * They serve as a contract: if the helper is ever extracted or changed,
 * these cases must continue to pass.
 */
import { describe, expect, it } from "vitest";

import type { OneKycConsentRequest, OneKycWorkflow } from "@/lib/services/one-kyc-service";

/** Local replica of the helper under test (must stay in sync with page.tsx). */
function workflowPendingConsentRequestIds(workflow: OneKycWorkflow): string[] {
  const ids = new Set<string>();
  for (const request of workflow.consent_requests || []) {
    if (request.request_id && request.status !== "granted") {
      ids.add(request.request_id);
    }
  }
  if (
    ids.size === 0 &&
    (!workflow.consent_requests || workflow.consent_requests.length === 0) &&
    workflow.consent_request_id
  ) {
    ids.add(workflow.consent_request_id);
  }
  return Array.from(ids);
}

function baseWorkflow(overrides: Partial<OneKycWorkflow> = {}): OneKycWorkflow {
  return {
    workflow_id: "wf_test",
    user_id: "user_1",
    status: "needs_scope",
    participant_emails: ["broker@example.com"],
    required_fields: [],
    ...overrides,
  };
}

function req(request_id: string, status: OneKycConsentRequest["status"]): OneKycConsentRequest {
  return { request_id, scope: "attr.identity.*", status };
}

describe("workflowPendingConsentRequestIds", () => {
  it("returns only the requested (non-granted) ID in a MIXED bundle", () => {
    const workflow = baseWorkflow({
      consent_requests: [
        req("okyc_de57", "granted"),
        req("okyc_2_abc", "requested"),
      ],
    });
    expect(workflowPendingConsentRequestIds(workflow)).toEqual(["okyc_2_abc"]);
  });

  it("returns [] when all consent requests are already granted", () => {
    const workflow = baseWorkflow({
      consent_requests: [
        req("okyc_1", "granted"),
        req("okyc_2", "granted"),
      ],
    });
    expect(workflowPendingConsentRequestIds(workflow)).toEqual([]);
  });

  it("returns all IDs when all consent requests are pending", () => {
    const workflow = baseWorkflow({
      consent_requests: [
        req("okyc_a", "requested"),
        req("okyc_b", "requested"),
      ],
    });
    expect(workflowPendingConsentRequestIds(workflow)).toEqual(["okyc_a", "okyc_b"]);
  });

  it("single-request fallback: uses top-level consent_request_id when consent_requests is absent", () => {
    const workflow = baseWorkflow({
      consent_request_id: "okyc_legacy",
      consent_requests: undefined,
    });
    expect(workflowPendingConsentRequestIds(workflow)).toEqual(["okyc_legacy"]);
  });

  it("single-request fallback: uses top-level consent_request_id when consent_requests is empty", () => {
    const workflow = baseWorkflow({
      consent_request_id: "okyc_legacy",
      consent_requests: [],
    });
    expect(workflowPendingConsentRequestIds(workflow)).toEqual(["okyc_legacy"]);
  });

  it("does NOT fall back to top-level ID when per-entry list is present even if all granted", () => {
    // All granted → pending set is empty, but consent_requests is non-empty so
    // fallback must not activate (we don't want to re-approve a granted request).
    const workflow = baseWorkflow({
      consent_request_id: "okyc_top",
      consent_requests: [req("okyc_1", "granted")],
    });
    expect(workflowPendingConsentRequestIds(workflow)).toEqual([]);
  });

  it("skips entries with a missing request_id", () => {
    const workflow = baseWorkflow({
      consent_requests: [
        { request_id: "", scope: "attr.identity.*", status: "requested" },
        req("okyc_valid", "requested"),
      ],
    });
    expect(workflowPendingConsentRequestIds(workflow)).toEqual(["okyc_valid"]);
  });
});
