// hushh-webapp/lib/services/account-service.ts
import { Capacitor } from "@capacitor/core";
import { HushhAccount } from "@/lib/capacitor";
import { apiJson } from "./api-client";
import { trackEvent } from "@/lib/observability/client";

export type AccountDeletionTarget = "investor" | "ria" | "both";

export interface AccountDeletionResult {
  success: boolean;
  message?: string;
  requested_target?: AccountDeletionTarget;
  deleted_target?: AccountDeletionTarget;
  account_deleted?: boolean;
  remaining_personas?: Array<"investor" | "ria">;
  details?: Record<string, unknown>;
}

export interface AccountDataExportResult {
  success: boolean;
  exported_at?: string;
  requested_target?: "account";
  data?: {
    actor_profile?: Record<string, unknown> | null;
    runtime_persona_state?: Record<string, unknown> | null;
    encrypted_vault_keys?: Array<Record<string, unknown>>;
    encrypted_pkm_manifests?: Array<Record<string, unknown>>;
    encrypted_pkm_index?: Array<Record<string, unknown>>;
    encrypted_pkm_blobs?: Array<Record<string, unknown>>;
    consent_audit?: Array<Record<string, unknown>>;
  };
}

export class AccountServiceImpl {
  /**
   * Delete the user's account and all data.
   * Requires VAULT_OWNER token (Unlock to Delete).
   * 
   * SECURITY: Token must be passed explicitly from useVault() hook.
   * Never reads from sessionStorage (XSS protection).
   * 
   * @param vaultOwnerToken - The VAULT_OWNER consent token (REQUIRED)
   */
  async deleteAccount(
    vaultOwnerToken: string,
    target: AccountDeletionTarget = "both"
  ): Promise<AccountDeletionResult> {
    if (!vaultOwnerToken) {
      throw new Error("VAULT_OWNER token required - vault must be unlocked");
    }
    
    trackEvent("account_delete_requested", {
      result: "success",
    });

    console.log("[AccountService] Deleting account with target:", target);

    try {
      if (Capacitor.isNativePlatform()) {
        // Native: Call Capacitor plugin directly to Python backend
        const result = await HushhAccount.deleteAccount({
          authToken: vaultOwnerToken,
          target,
        });
        trackEvent("account_delete_completed", {
          result: result.success ? "success" : "error",
          status_bucket: result.success ? "2xx" : "5xx",
        });
        return result;
      } else {
        // Web: Call Next.js proxy
        const result = await apiJson<AccountDeletionResult>(
          "/api/account/delete",
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${vaultOwnerToken}`,
            },
            body: JSON.stringify({ target }),
          }
        );
        trackEvent("account_delete_completed", {
          result: result.success ? "success" : "error",
          status_bucket: result.success ? "2xx" : "5xx",
        });
        return result;
      }
    } catch (error) {
      console.error("Account deletion failed:", error);
      trackEvent("account_delete_completed", {
        result: "error",
        status_bucket: "5xx",
      });
      throw error;
    }
  }

  /**
   * Export user data.
   */
  async exportData(vaultOwnerToken: string): Promise<AccountDataExportResult> {
    if (!vaultOwnerToken) {
      throw new Error("VAULT_OWNER token required - vault must be unlocked");
    }

    return apiJson<AccountDataExportResult>("/api/account/export", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
      },
    });
  }
}

export const AccountService = new AccountServiceImpl();
