import { apiJson } from "@/lib/services/api-client";
import type {
  KycClientConnectorPrivateRecord,
  KycScopedExportPackage,
} from "@/lib/services/one-kyc-client-zk-service";

export type OneKycWorkflowStatus =
  | "needs_client_connector"
  | "needs_scope"
  | "needs_documents"
  | "drafting"
  | "waiting_on_user"
  | "waiting_on_counterparty"
  | "completed"
  | "blocked";

export interface OneKycWorkflow {
  workflow_id: string;
  user_id: string | null;
  status: OneKycWorkflowStatus;
  gmail_thread_id?: string | null;
  gmail_message_id?: string | null;
  sender_email?: string | null;
  sender_name?: string | null;
  participant_emails: string[];
  subject?: string | null;
  snippet?: string | null;
  counterparty_label?: string | null;
  required_fields: string[];
  requested_scope?: string | null;
  consent_request_id?: string | null;
  consent_request_url?: string | null;
  workflow_url?: string | null;
  draft_subject?: string | null;
  draft_body?: string | null;
  draft_status?: "not_ready" | "ready" | "sent" | "rejected" | null;
  consent_export?: Record<string, unknown> | null;
  send_status?: "not_started" | "sending" | "sent" | "failed" | null;
  sent_message_id?: string | null;
  sent_at?: string | null;
  pkm_writeback_status?: "not_started" | "pending" | "succeeded" | "failed" | null;
  pkm_writeback_artifact_hash?: string | null;
  pkm_writeback_attempt_count?: number | null;
  pkm_writeback_last_error?: string | null;
  pkm_writeback_completed_at?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface OneKycWorkflowListResponse {
  workflows: OneKycWorkflow[];
}

export interface OneKycClientConnectorResponse {
  configured: boolean;
  connector: {
    connector_key_id: string;
    connector_public_key: string;
    connector_wrapping_alg: string;
    public_key_fingerprint?: string | null;
    status?: string | null;
  } | null;
}

type AuthInput = {
  userId: string;
  vaultOwnerToken: string;
};

function authHeaders(vaultOwnerToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${vaultOwnerToken}`,
    "Content-Type": "application/json",
  };
}

export class OneKycService {
  static listWorkflows({ userId, vaultOwnerToken }: AuthInput): Promise<OneKycWorkflowListResponse> {
    const query = new URLSearchParams({ user_id: userId });
    return apiJson<OneKycWorkflowListResponse>(`/api/one/kyc/workflows?${query.toString()}`, {
      headers: authHeaders(vaultOwnerToken),
    });
  }

  static getWorkflow({
    userId,
    vaultOwnerToken,
    workflowId,
  }: AuthInput & { workflowId: string }): Promise<OneKycWorkflow> {
    const query = new URLSearchParams({ user_id: userId });
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}?${query.toString()}`,
      {
        headers: authHeaders(vaultOwnerToken),
      }
    );
  }

  static refreshWorkflow({
    userId,
    vaultOwnerToken,
    workflowId,
  }: AuthInput & { workflowId: string }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/refresh`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({ user_id: userId }),
      }
    );
  }

  static sendApprovedReply({
    userId,
    vaultOwnerToken,
    workflowId,
    approvedSubject,
    approvedBody,
    clientDraftHash,
    consentExportRevision,
    pkmWritebackArtifactHash,
  }: AuthInput & {
    workflowId: string;
    approvedSubject?: string | null;
    approvedBody: string;
    clientDraftHash?: string | null;
    consentExportRevision?: number | null;
    pkmWritebackArtifactHash: string;
  }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/send-approved-reply`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          user_id: userId,
          approved_subject: approvedSubject,
          approved_body: approvedBody,
          client_draft_hash: clientDraftHash,
          consent_export_revision: consentExportRevision,
          pkm_writeback_artifact_hash: pkmWritebackArtifactHash,
        }),
      }
    );
  }

  static rejectDraft({
    userId,
    vaultOwnerToken,
    workflowId,
    reason,
  }: AuthInput & { workflowId: string; reason?: string }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/reject-draft`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({ user_id: userId, reason }),
      }
    );
  }

  static redraft({
    userId,
    vaultOwnerToken,
    workflowId,
    instructions,
    source = "text",
  }: AuthInput & {
    workflowId: string;
    instructions: string;
    source?: "text" | "voice";
  }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/redraft`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({ user_id: userId, instructions, source }),
      }
    );
  }

  static getClientConnector({
    userId,
    vaultOwnerToken,
  }: AuthInput): Promise<OneKycClientConnectorResponse> {
    const query = new URLSearchParams({ user_id: userId });
    return apiJson<OneKycClientConnectorResponse>(
      `/api/one/kyc/client-connector?${query.toString()}`,
      { headers: authHeaders(vaultOwnerToken) }
    );
  }

  static registerClientConnector({
    userId,
    vaultOwnerToken,
    connector,
  }: AuthInput & { connector: KycClientConnectorPrivateRecord }): Promise<OneKycClientConnectorResponse> {
    return apiJson<OneKycClientConnectorResponse>("/api/one/kyc/client-connector", {
      method: "POST",
      headers: authHeaders(vaultOwnerToken),
      body: JSON.stringify({
        user_id: userId,
        connector_public_key: connector.connector_public_key,
        connector_key_id: connector.connector_key_id,
        connector_wrapping_alg: connector.connector_wrapping_alg,
        public_key_fingerprint: connector.public_key_fingerprint,
      }),
    });
  }

  static getWorkflowConsentExport({
    userId,
    vaultOwnerToken,
    workflowId,
  }: AuthInput & { workflowId: string }): Promise<KycScopedExportPackage> {
    const query = new URLSearchParams({ user_id: userId });
    return apiJson<KycScopedExportPackage>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/consent-export?${query.toString()}`,
      {
        headers: authHeaders(vaultOwnerToken),
      }
    );
  }

  static writebackComplete({
    userId,
    vaultOwnerToken,
    workflowId,
    artifactHash,
    status = "succeeded",
    errorMessage,
  }: AuthInput & {
    workflowId: string;
    artifactHash: string;
    status?: "succeeded" | "failed";
    errorMessage?: string | null;
  }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/writeback-complete`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          user_id: userId,
          artifact_hash: artifactHash,
          status,
          error_message: errorMessage,
        }),
      }
    );
  }
}
