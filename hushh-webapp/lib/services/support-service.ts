import { ApiService } from "@/lib/services/api-service";

export type SupportMessageKind =
  | "bug_report"
  | "support_request"
  | "developer_reachout";

export interface SubmitSupportMessageParams {
  idToken: string;
  userId: string;
  kind: SupportMessageKind;
  subject: string;
  message: string;
  persona?: string | null;
  pageUrl?: string | null;
}

export interface SubmitSupportMessageResponse {
  accepted: boolean;
  delivery_status: "accepted_by_provider";
  kind: SupportMessageKind;
}

export class SupportDeliveryUncertainError extends Error {}

export class SupportService {
  static async submitMessage(
    params: SubmitSupportMessageParams
  ): Promise<SubmitSupportMessageResponse> {
    let response: Response;
    try {
      response = await ApiService.apiFetch("/api/kai/support/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.idToken}`,
        },
        body: JSON.stringify({
          user_id: params.userId,
          kind: params.kind,
          subject: params.subject,
          message: params.message,
          persona: params.persona || null,
          page_url: params.pageUrl || null,
        }),
      });
    } catch {
      // A dropped response does not prove Gmail rejected the request.
      throw new SupportDeliveryUncertainError("Delivery could not be confirmed. Please wait before retrying.");
    }

    const payload = (await response.json().catch(() => ({}))) as
      | SubmitSupportMessageResponse
      | {
          detail?: { code?: string; message?: string } | string;
          error?: string;
        };

    if (!response.ok) {
      const detailCode = typeof (payload as { detail?: { code?: string } }).detail === "object"
        ? (payload as { detail: { code?: string } }).detail?.code
        : undefined;
      if (detailCode === "SUPPORT_DELIVERY_UNCERTAIN") {
        throw new SupportDeliveryUncertainError("Delivery could not be confirmed. Please wait before retrying.");
      }
      const detail =
        typeof (payload as { detail?: string }).detail === "string"
          ? (payload as { detail?: string }).detail
          : typeof (payload as { detail?: { message?: string } }).detail?.message === "string"
            ? (payload as { detail: { message?: string } }).detail.message
            : typeof (payload as { error?: string }).error === "string"
              ? (payload as { error?: string }).error
              : `Failed to send support message: ${response.status}`;
      throw new Error(detail);
    }

    const result = payload as SubmitSupportMessageResponse;
    if (result.accepted !== true || result.delivery_status !== "accepted_by_provider") {
      throw new Error("Support delivery was not confirmed.");
    }
    return result;
  }
}
