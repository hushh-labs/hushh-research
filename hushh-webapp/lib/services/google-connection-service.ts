import { ApiService } from "@/lib/services/api-service";
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
};

export type GoogleConnectionCompletion = GoogleConnectionStatus & {
  service: "calendar" | "drive";
};

/** One callback transport; the server's consumed attempt identifies the service. */
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
      !["calendar", "drive"].includes(result.service) ||
      typeof result.connected !== "boolean" ||
      !["connected", "needs_reauth", "disconnected"].includes(result.status)
    ) {
      throw new Error("Google connection could not be verified.");
    }
    return result as GoogleConnectionCompletion;
  }
}
