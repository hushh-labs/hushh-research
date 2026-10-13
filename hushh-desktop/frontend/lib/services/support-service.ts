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
  userEmail?: string | null;
  userDisplayName?: string | null;
  persona?: string | null;
  pageUrl?: string | null;
}

export interface SubmitSupportMessageResponse {
  accepted: boolean;
  delivery_mode: "live" | "test";
  recipient: string;
  intended_recipient: string;
  from_email: string;
  message_id?: string | null;
}

export class SupportService {
  static async submitMessage(
    params: SubmitSupportMessageParams
  ): Promise<SubmitSupportMessageResponse> {
    const response = await ApiService.apiFetch("/api/kai/support/message", {
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
        user_email: params.userEmail || null,
        user_display_name: params.userDisplayName || null,
        persona: params.persona || null,
        page_url: params.pageUrl || null,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as
      | SubmitSupportMessageResponse
      | {
          detail?: { message?: string } | string;
          error?: string;
        };

    if (!response.ok) {
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

    return payload as SubmitSupportMessageResponse;
  }
}
