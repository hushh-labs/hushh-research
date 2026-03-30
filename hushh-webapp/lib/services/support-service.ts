import { ApiService } from "@/lib/services/api-service";
import { SUPPORT_API_TEMPLATES } from "@/lib/services/kai-profile-api-paths";

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

function safeSupportErrorMessage(status: number): string {
  if (status === 400 || status === 413 || status === 422) {
    return "We couldn't send your message. Check the subject and details, then try again.";
  }
  if (status === 401 || status === 403) {
    return "Please sign in again before sending a message.";
  }
  if (status === 429) {
    return "You're sending messages too quickly. Please wait a minute and try again.";
  }
  return "We couldn't send your message right now. Please try again.";
}

export class SupportService {
  static async submitMessage(
    params: SubmitSupportMessageParams
  ): Promise<SubmitSupportMessageResponse> {
    const response = await ApiService.apiFetch(SUPPORT_API_TEMPLATES.message, {
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
      throw new Error(safeSupportErrorMessage(response.status));
    }

    return payload as SubmitSupportMessageResponse;
  }
}
