import { apiJson } from "@/lib/services/api-client";

export type GmailInformationRequestPreference = {
  user_id: string;
  monitoring_enabled: boolean;
  retention: "metadata_only";
  disclosure: string;
  monitoring_enabled_at?: string | null;
  last_scan_completed_at?: string | null;
  updated_at?: string | null;
};

export type GmailInformationRequestCandidateScope = {
  scope: string;
  domain: string;
  label: string;
  segment_ids: string[];
};

export type GmailInformationRequestWorkflow = {
  workflow_id: string;
  status: "detected" | "ignored" | "blocked" | "sent";
  gmail_thread_id: string | null;
  received_at: string | null;
  classification_confidence: number;
  requested_field_labels: string[];
  candidate_scopes: GmailInformationRequestCandidateScope[];
  attachment_review_required: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

export type GmailInformationRequestList = {
  workflows: GmailInformationRequestWorkflow[];
  limit: number;
  offset: number;
  next_offset: number | null;
  total_count: number;
};

export type GmailInformationRequestScan = {
  accepted: boolean;
  scanned_count: number;
  unchanged_count: number;
  matched_count: number;
  failed_count: number;
  workflow_ids: string[];
};

export type GmailPreparedInformationRequestReply = {
  actionId: string;
  expiresAt: string | null;
  preview: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    gmailThreadId: string;
  };
};

export type GmailSentInformationRequestReply = {
  state: "sent" | "outcome_unknown" | string;
  outcomeUnknown: boolean;
};

function accountHeaders(firebaseIdToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${firebaseIdToken}`,
    "Content-Type": "application/json",
  };
}

function ownerHeaders(
  firebaseIdToken: string,
  vaultOwnerToken: string,
): HeadersInit {
  return {
    ...accountHeaders(firebaseIdToken),
    "X-Hushh-Consent": `Bearer ${vaultOwnerToken}`,
  };
}

export class GmailInformationRequestsService {
  static getPreference(input: {
    userId: string;
    firebaseIdToken: string;
  }): Promise<GmailInformationRequestPreference> {
    const query = new URLSearchParams({ user_id: input.userId });
    return apiJson<GmailInformationRequestPreference>(
      `/api/one/email/information-requests/preference?${query.toString()}`,
      { headers: accountHeaders(input.firebaseIdToken) },
    );
  }

  static setPreference(input: {
    userId: string;
    firebaseIdToken: string;
    enabled: boolean;
  }): Promise<GmailInformationRequestPreference> {
    return apiJson<GmailInformationRequestPreference>(
      "/api/one/email/information-requests/preference",
      {
        method: "PATCH",
        headers: accountHeaders(input.firebaseIdToken),
        body: JSON.stringify({ user_id: input.userId, enabled: input.enabled }),
      },
    );
  }

  static list(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    limit?: number;
    offset?: number;
  }): Promise<GmailInformationRequestList> {
    const query = new URLSearchParams();
    if (input.limit) query.set("limit", String(input.limit));
    if (input.offset) query.set("offset", String(input.offset));
    const suffix = query.size ? `?${query.toString()}` : "";
    return apiJson<GmailInformationRequestList>(
      `/api/one/email/information-requests${suffix}`,
      { headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken) },
    );
  }

  static scan(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    maxResults?: number;
  }): Promise<GmailInformationRequestScan> {
    return apiJson<GmailInformationRequestScan>(
      "/api/one/email/information-requests/scan",
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({ max_results: input.maxResults ?? 12 }),
      },
    );
  }

  static prepareReply(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    workflowId: string;
    body: string;
    htmlBody?: string | null;
    idempotencyKey: string;
  }): Promise<GmailPreparedInformationRequestReply> {
    return apiJson<{
      action_id: string;
      expires_at: string | null;
      preview: {
        to: string[];
        cc: string[];
        bcc: string[];
        subject: string;
        gmail_thread_id: string;
      };
    }>(
      `/api/one/email/information-requests/${encodeURIComponent(input.workflowId)}/prepare-reply`,
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({
          body: input.body,
          html_body: input.htmlBody ?? null,
          idempotency_key: input.idempotencyKey,
        }),
      },
    ).then((response) => ({
      actionId: response.action_id,
      expiresAt: response.expires_at,
      preview: {
        to: response.preview.to,
        cc: response.preview.cc,
        bcc: response.preview.bcc,
        subject: response.preview.subject,
        gmailThreadId: response.preview.gmail_thread_id,
      },
    }));
  }

  static ignore(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    workflowId: string;
  }): Promise<{ workflow_id: string; status: "ignored" }> {
    return apiJson<{ workflow_id: string; status: "ignored" }>(
      `/api/one/email/information-requests/${encodeURIComponent(input.workflowId)}/ignore`,
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
      },
    );
  }

  static sendReply(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    workflowId: string;
    actionId: string;
    body: string;
    htmlBody?: string | null;
  }): Promise<GmailSentInformationRequestReply> {
    return apiJson<{ state: string; outcome_unknown?: boolean }>(
      `/api/one/email/information-requests/${encodeURIComponent(input.workflowId)}/send-reply`,
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({
          action_id: input.actionId,
          body: input.body,
          html_body: input.htmlBody ?? null,
        }),
      },
    ).then((response) => ({
      state: response.state,
      outcomeUnknown: response.outcome_unknown === true,
    }));
  }
}
