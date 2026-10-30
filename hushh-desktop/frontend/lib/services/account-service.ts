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
    verified_email_aliases?: AccountEmailAlias[];
    consent_audit?: Array<Record<string, unknown>>;
  };
}

export interface AccountEmailAlias {
  alias_id: string;
  user_id: string;
  email: string;
  email_normalized: string;
  verification_status: "pending" | "verified" | "revoked" | "expired";
  verification_source: string;
  source_ref?: string | null;
  verification_requested_at?: string | null;
  verified_at?: string | null;
  revoked_at?: string | null;
  last_matched_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AccountEmailAliasesResponse {
  success: boolean;
  user_id: string;
  aliases: AccountEmailAlias[];
}

export interface AccountEmailAliasVerificationStartResponse {
  success: boolean;
  user_id: string;
  alias: AccountEmailAlias;
  already_verified: boolean;
  review_verification_code?: string | null;
}

export interface AccountEmailAliasVerificationConfirmResponse {
  success: boolean;
  user_id: string;
  alias: AccountEmailAlias;
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

  async listEmailAliases(vaultOwnerToken: string): Promise<AccountEmailAliasesResponse> {
    if (!vaultOwnerToken) {
      throw new Error("VAULT_OWNER token required - vault must be unlocked");
    }

    return apiJson<AccountEmailAliasesResponse>("/api/account/email-aliases", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
      },
    });
  }

  async startEmailAliasVerification(
    vaultOwnerToken: string,
    email: string
  ): Promise<AccountEmailAliasVerificationStartResponse> {
    if (!vaultOwnerToken) {
      throw new Error("VAULT_OWNER token required - vault must be unlocked");
    }

    return apiJson<AccountEmailAliasVerificationStartResponse>(
      "/api/account/email-aliases/verification/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vaultOwnerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      }
    );
  }

  async confirmEmailAliasVerification(
    vaultOwnerToken: string,
    email: string,
    verificationCode: string
  ): Promise<AccountEmailAliasVerificationConfirmResponse> {
    if (!vaultOwnerToken) {
      throw new Error("VAULT_OWNER token required - vault must be unlocked");
    }

    return apiJson<AccountEmailAliasVerificationConfirmResponse>(
      "/api/account/email-aliases/verification/confirm",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vaultOwnerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, verification_code: verificationCode }),
      }
    );
  }
}

export const AccountService = new AccountServiceImpl();
