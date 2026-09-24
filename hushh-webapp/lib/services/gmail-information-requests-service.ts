import { apiJson } from "@/lib/services/api-client";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

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
  /** Shared KYC IDs are metadata only; no private values leave the vault. */
  canonical_field_ids?: string[];
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
  view?: "active" | "activity";
};

export type GmailInformationRequestScan = {
  accepted: boolean;
  scanned_count: number;
  unchanged_count: number;
  matched_count: number;
  failed_count: number;
  workflow_ids: string[];
  baseline_established?: boolean;
  baseline_reestablished?: boolean;
  retry_pending?: boolean;
};

export type GmailInformationRequestScanStreamHandlers = {
  onProgress: (scannedCount: number) => void;
  onRequest: (workflow: GmailInformationRequestWorkflow) => void;
};

export type GmailInformationRequestCandidateRefresh = {
  workflow_id: string;
  candidate_scopes: GmailInformationRequestCandidateScope[];
};

export type GmailInformationRequestSourcePreview = {
  from: string;
  /** A source-provided Reply-To address, when Gmail supplied one. */
  reply_to?: string;
  subject: string;
  body: string;
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

function messageForStreamResponse(payload: unknown): string {
  const record = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
  const detail = record.detail && typeof record.detail === "object"
    ? (record.detail as Record<string, unknown>)
    : record;
  return typeof detail.message === "string" && detail.message
    ? detail.message
    : "We couldn’t check Gmail right now. Try again.";
}

function isScan(value: unknown): value is GmailInformationRequestScan {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.accepted === true &&
    ["scanned_count", "unchanged_count", "matched_count", "failed_count"].every(
      (key) => typeof record[key] === "number",
    ) &&
    Array.isArray(record.workflow_ids)
  );
}

function isWorkflow(value: unknown): value is GmailInformationRequestWorkflow {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workflow_id === "string" &&
    record.status === "detected" &&
    Array.isArray(record.requested_field_labels) &&
    Array.isArray(record.candidate_scopes) &&
    typeof record.attachment_review_required === "boolean"
  );
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
    vaultOwnerToken: string;
    enabled: boolean;
  }): Promise<GmailInformationRequestPreference> {
    return apiJson<GmailInformationRequestPreference>(
      "/api/one/email/information-requests/preference",
      {
        method: "PATCH",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({ user_id: input.userId, enabled: input.enabled }),
      },
    );
  }

  static list(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    limit?: number;
    offset?: number;
    view?: "active" | "activity";
  }): Promise<GmailInformationRequestList> {
    const query = new URLSearchParams();
    if (input.limit) query.set("limit", String(input.limit));
    if (input.offset) query.set("offset", String(input.offset));
    if (input.view === "activity") query.set("view", "activity");
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
    includeRecentInbox?: boolean;
  }): Promise<GmailInformationRequestScan> {
    return apiJson<GmailInformationRequestScan>(
      "/api/one/email/information-requests/scan",
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({
          max_results: input.maxResults ?? 30,
          include_recent_inbox: input.includeRecentInbox === true,
        }),
      },
    );
  }

  /**
   * Scan a connected inbox while delivering metadata-only progress and newly
   * durable KYC requests as they are found. The normal JSON scan stays intact
   * for callers that only need the final result.
   */
  static async scanStream(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    maxResults?: number;
    includeRecentInbox?: boolean;
    signal?: AbortSignal;
    handlers: GmailInformationRequestScanStreamHandlers;
  }): Promise<GmailInformationRequestScan> {
    const response = await nativeStreamFetch(
      "/api/one/email/information-requests/scan/stream",
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({
          max_results: input.maxResults ?? 30,
          include_recent_inbox: input.includeRecentInbox === true,
        }),
        signal: input.signal,
      },
    );
    if (!response.ok) {
      throw new Error(messageForStreamResponse(await response.json().catch(() => null)));
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error("We couldn’t check Gmail right now. Try again.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("We couldn’t check Gmail right now. Try again.");

    let completed: GmailInformationRequestScan | null = null;
    let buffer = "";
    const decoder = new TextDecoder();
    const dispatch = (frame: { event: string; data: string }) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.event !== frame.event) return;
      if (frame.event === "progress" && typeof payload.scanned_count === "number") {
        input.handlers.onProgress(Math.max(0, Math.floor(payload.scanned_count)));
      } else if (frame.event === "request" && isWorkflow(payload.workflow)) {
        input.handlers.onRequest(payload.workflow);
      } else if (frame.event === "complete" && isScan(payload)) {
        completed = payload;
      } else if (frame.event === "error") {
        throw new Error(messageForStreamResponse(payload));
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseSSEBlocks(decoder.decode(value, { stream: true }), buffer);
        buffer = parsed.remainder;
        for (const frame of parsed.events) dispatch(frame);
      }
      if (buffer.trim()) {
        for (const frame of parseSSEBlocks("\n\n", buffer).events) dispatch(frame);
      }
    } finally {
      reader.releaseLock();
    }
    if (!completed) throw new Error("We couldn’t check Gmail right now. Try again.");
    return completed;
  }

  /**
   * Re-resolve the detected request against the owner's current PKM manifest.
   * This returns scope metadata only; decrypted values remain in the unlocked client.
   */
  static refreshCandidates(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    workflowId: string;
  }): Promise<GmailInformationRequestCandidateRefresh> {
    return apiJson<GmailInformationRequestCandidateRefresh>(
      `/api/one/email/information-requests/${encodeURIComponent(input.workflowId)}/refresh-candidates`,
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
      },
    );
  }

  /** Fetches the source email only for the unlocked workflow owner on demand. */
  static getSourcePreview(input: {
    firebaseIdToken: string;
    vaultOwnerToken: string;
    workflowId: string;
  }): Promise<GmailInformationRequestSourcePreview> {
    return apiJson<GmailInformationRequestSourcePreview>(
      `/api/one/email/information-requests/${encodeURIComponent(input.workflowId)}/source-preview`,
      { headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken) },
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
      "/api/one/email/prepare",
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({
          body: input.body,
          html_body: input.htmlBody ?? null,
          idempotency_key: input.idempotencyKey,
          source_workflow_id: input.workflowId,
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
      "/api/one/email/send",
      {
        method: "POST",
        headers: ownerHeaders(input.firebaseIdToken, input.vaultOwnerToken),
        body: JSON.stringify({
          action_id: input.actionId,
          body: input.body,
          html_body: input.htmlBody ?? null,
          source_workflow_id: input.workflowId,
        }),
      },
    ).then((response) => ({
      state: response.state,
      outcomeUnknown: response.outcome_unknown === true,
    }));
  }
}
