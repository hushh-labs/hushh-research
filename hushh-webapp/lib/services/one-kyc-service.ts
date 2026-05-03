import { apiJson } from "@/lib/services/api-client";

export type OneKycWorkflowStatus =
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
  last_error_code?: string | null;
  last_error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface OneKycWorkflowListResponse {
  workflows: OneKycWorkflow[];
}

type AuthInput = {
  userId: string;
  idToken: string;
};

function authHeaders(idToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
  };
}

export class OneKycService {
  static listWorkflows({ userId, idToken }: AuthInput): Promise<OneKycWorkflowListResponse> {
    const query = new URLSearchParams({ user_id: userId });
    return apiJson<OneKycWorkflowListResponse>(`/api/one/kyc/workflows?${query.toString()}`, {
      headers: authHeaders(idToken),
    });
  }

  static getWorkflow({
    userId,
    idToken,
    workflowId,
  }: AuthInput & { workflowId: string }): Promise<OneKycWorkflow> {
    const query = new URLSearchParams({ user_id: userId });
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}?${query.toString()}`,
      {
        headers: authHeaders(idToken),
      }
    );
  }

  static refreshWorkflow({
    userId,
    idToken,
    workflowId,
  }: AuthInput & { workflowId: string }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/refresh`,
      {
        method: "POST",
        headers: authHeaders(idToken),
        body: JSON.stringify({ user_id: userId }),
      }
    );
  }

  static approveDraft({
    userId,
    idToken,
    workflowId,
  }: AuthInput & { workflowId: string }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/approve-draft`,
      {
        method: "POST",
        headers: authHeaders(idToken),
        body: JSON.stringify({ user_id: userId }),
      }
    );
  }

  static rejectDraft({
    userId,
    idToken,
    workflowId,
    reason,
  }: AuthInput & { workflowId: string; reason?: string }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/reject-draft`,
      {
        method: "POST",
        headers: authHeaders(idToken),
        body: JSON.stringify({ user_id: userId, reason }),
      }
    );
  }

  static redraft({
    userId,
    idToken,
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
        headers: authHeaders(idToken),
        body: JSON.stringify({ user_id: userId, instructions, source }),
      }
    );
  }
}
