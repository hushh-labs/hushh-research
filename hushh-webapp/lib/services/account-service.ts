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
  async exportData(): Promise<any> {
    // TODO: Implement export
    return {};
  }
}

export const AccountService = new AccountServiceImpl();
