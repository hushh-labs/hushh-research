import { requireSharedGoogleExchange } from './private-google-connections';
import { ApiService } from "@/lib/services/api-service";
import type { GoogleCalendarAccount } from "@/lib/services/google-calendar-service";
import {
  snapshotValidatedAuthSessionOwner,
  isValidatedAuthSessionOwnerCurrent,
} from "@/lib/auth/session-owner";

export type GoogleConnectionStatus = {
  configured: boolean;
  connected: boolean;
  google_email?: string | null;
  status: "connected" | "needs_reauth" | "disconnected";
  access_level?: "read" | "manage" | null;
  scope_csv: string;
  /** Calendar only: whether Google granted subscribed-calendar discovery. */
  calendar_list_access?: boolean;
  /** Calendar only: optional guest profile access granted in its OAuth flow. */
  guest_photo_access?: boolean;
};

export type GoogleConnectionCompletion = GoogleConnectionStatus & {
  service: "calendar";
  /** Identifies the grant published by an Add account attempt, including "default" when reauthorized. */
  completed_account_id?: string;
  accounts?: GoogleCalendarAccount[];
};

/** Legacy Calendar callback transport; Drive uses `/api/connectors` instead. */
export class GoogleConnectionService {
  static async completeConnect(params: {
    idToken: string;
    userId: string;
    code: string;
    state: string;
    isEffectCurrent: () => boolean;
  }): Promise<GoogleConnectionCompletion> {
    const owner = snapshotValidatedAuthSessionOwner();
    const isEffectCurrent = () =>
      Boolean(
        owner &&
        owner.userId === params.userId &&
        isValidatedAuthSessionOwnerCurrent(owner) &&
        params.isEffectCurrent(),
      );
    if (!isEffectCurrent())
      throw new DOMException("The connection session changed.", "AbortError");
    await requireSharedGoogleExchange();
    if (!isEffectCurrent()) throw new DOMException("The connection session changed.", "AbortError");
    const response = await ApiService.apiFetch(
      "/api/one/google/connect/complete",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: params.userId,
          code: params.code,
          state: params.state,
          redirect_uri: typeof window === "undefined" ? undefined
            : `${window.location.origin}/one/profile/google/oauth/return`,
        }),
        isEffectCurrent,
      },
    );
    if (!response.ok)
      throw new Error("Google connection could not be completed.");
    const result = await response.json();
    if (!isEffectCurrent())
      throw new DOMException("The connection session changed.", "AbortError");
    if (
      !result ||
      result.service !== "calendar" ||
      typeof result.connected !== "boolean" ||
      !["connected", "needs_reauth", "disconnected"].includes(result.status) ||
      (result.completed_account_id !== undefined &&
        (typeof result.completed_account_id !== "string" ||
          !result.completed_account_id ||
          !Array.isArray(result.accounts)))
    ) {
      throw new Error("Google connection could not be verified.");
    }
    return result as GoogleConnectionCompletion;
  }
}
