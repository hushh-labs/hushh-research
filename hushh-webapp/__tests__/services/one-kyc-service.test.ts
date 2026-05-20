import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson } = vi.hoisted(() => ({
  mockApiJson: vi.fn(),
}));

vi.mock("@/lib/services/api-client", () => ({
  apiJson: mockApiJson,
}));

import { OneKycService } from "@/lib/services/one-kyc-service";

const KYC_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM";

describe("OneKycService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiJson.mockResolvedValue({});
  });

  it("registers the public connector without sending the private key", async () => {
    await OneKycService.registerClientConnector({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      connector: {
        connector_key_id: "one-kyc-public",
        connector_public_key: "public-key",
        connector_private_key: "private-key-must-stay-client-side",
        connector_private_key_format: "pkcs8",
        connector_wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
        public_key_fingerprint: "fingerprint",
        created_at: "2026-05-04T00:00:00.000Z",
      },
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/kyc/client-connector", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: "user_1",
        connector_public_key: "public-key",
        connector_key_id: "one-kyc-public",
        connector_wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
        public_key_fingerprint: "fingerprint",
      }),
    });
    expect(mockApiJson.mock.calls[0]?.[1]?.body).not.toContain("private-key");
  });

  it("sends the approved body only to the transient send-approved endpoint", async () => {
    await OneKycService.sendApprovedReply({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      workflowId: "wf_1",
      approvedSubject: "Re: KYC",
      approvedBody: "Approved final body",
      approvedHtml: "<p>Approved final body</p>",
      clientDraftHash: "draft-hash",
      consentExportRevision: 3,
      pkmWritebackArtifactHash: "a".repeat(64),
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/kyc/workflows/wf_1/send-approved-reply", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: "user_1",
        approved_subject: "Re: KYC",
        approved_body: "Approved final body",
        approved_html: "<p>Approved final body</p>",
        client_draft_hash: "draft-hash",
        consent_export_revision: 3,
        pkm_writeback_artifact_hash: "a".repeat(64),
      }),
    });
  });

  it("lists workflows with pagination and status filters", async () => {
    await OneKycService.listWorkflows({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      limit: 25,
      cursor: "cursor-token",
      status: "waiting_on_user",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/kyc/workflows?user_id=user_1&limit=25&cursor=cursor-token&status=waiting_on_user",
      {
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("syncs recent One mailbox messages before refreshing the request list", async () => {
    await OneKycService.syncRecentEmails({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      maxResults: 12,
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/email/sync/recent", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: "user_1",
        max_results: 12,
      }),
    });
  });

  it("archives a workflow through the request-list delete endpoint", async () => {
    await OneKycService.archiveWorkflow({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      workflowId: "wf_1",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/kyc/workflows/wf_1?user_id=user_1",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("loads encrypted consent exports through the workflow-scoped vault endpoint", async () => {
    await OneKycService.getWorkflowConsentExport({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      workflowId: "wf_1",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/kyc/workflows/wf_1/consent-export?user_id=user_1",
      {
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
      }
    );
  });

  it("submits user-selected scopes before consent creation", async () => {
    await OneKycService.selectScopes({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      workflowId: "wf_1",
      selectedScopes: ["attr.identity.*", "attr.financial.*"],
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/kyc/workflows/wf_1/scope-selection", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: "user_1",
        selected_scopes: ["attr.identity.*", "attr.financial.*"],
      }),
    });
  });

  it("loads all encrypted consent exports for multi-scope drafts", async () => {
    await OneKycService.getWorkflowConsentExports({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      workflowId: "wf_1",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/kyc/workflows/wf_1/consent-exports?user_id=user_1",
      {
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
      }
    );
  });

  it("marks encrypted PKM writeback completion separately from Gmail send", async () => {
    await OneKycService.writebackComplete({
      userId: "user_1",
      vaultOwnerToken: "vault-token",
      workflowId: "wf_1",
      artifactHash: "a".repeat(64),
      status: "succeeded",
      errorMessage: null,
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/kyc/workflows/wf_1/writeback-complete", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
          user_id: "user_1",
          artifact_hash: "a".repeat(64),
        status: "succeeded",
        error_message: null,
      }),
    });
  });
});
