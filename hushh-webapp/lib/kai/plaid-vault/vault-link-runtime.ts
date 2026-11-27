"use client";

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { resolvePlaidLinkPlatform } from "@/lib/capacitor/plaid-link";
import { loadPlaidLink } from "@/lib/kai/brokerage/plaid-link-loader";
import { resolvePlaidRedirectUri } from "@/lib/kai/brokerage/plaid-redirect-uri";
import { savePlaidOAuthResumeSession } from "@/lib/kai/brokerage/plaid-oauth-session";
import { createVaultLinkToken } from "./vault-client";

export type VaultSurface = "web" | "ios" | "android";

/** One launch only: XCTest supplies this through NSArgumentDomain, never persisted by product code. */
export const PLAID_SANDBOX_PROOF_PREFERENCE_KEY = "hushh_plaid_sandbox_proof";

export function isPlaidSandboxProofBuild(): boolean {
  return process.env.NEXT_PUBLIC_PLAID_SANDBOX_PROOF === "true";
}

async function plaidSandboxProofRequestedForLaunch(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return (await Preferences.get({ key: PLAID_SANDBOX_PROOF_PREFERENCE_KEY })).value === "1";
  } catch {
    return false;
  }
}

/**
 * A proof Link token can exist only when the immutable WebView build and the
 * single native test launch both opt in. A UAT bundle with the launch flag—or
 * a local proof bundle opened normally—fails before any backend request.
 */
export async function requirePlaidSandboxProofMarker(): Promise<boolean> {
  const builtForProof = isPlaidSandboxProofBuild();
  const requestedForLaunch = await plaidSandboxProofRequestedForLaunch();
  if (builtForProof !== requestedForLaunch) {
    throw new Error("Plaid sandbox proof requires the matching local build and native launch marker.");
  }
  return builtForProof;
}

function surfaceFor(platform: string): VaultSurface {
  return platform === "ios" || platform === "android" ? platform : "web";
}

/** A vault link token for this platform (Android only when native Link opens it). */
export async function createVaultLink(params: {
  vaultOwnerToken: string;
  /** Update mode: repair the Item this sealed token belongs to. */
  accessToken?: string;
  originSurface?: "profile_nws" | "agentone_chat";
  additionalProduct?: "investments" | "liabilities";
  selectAccounts?: boolean;
}): Promise<{ linkToken: string; platform: VaultSurface; redirectUri: string | null }> {
  const platform = await resolvePlaidLinkPlatform();
  const sandboxProof = await requirePlaidSandboxProofMarker();
  const redirectUri = platform === "android" ? null : resolvePlaidRedirectUri() ?? null;
  const link = await createVaultLinkToken({
    vaultOwnerToken: params.vaultOwnerToken,
    request: {
      platform,
      redirect_uri: redirectUri,
      ...(sandboxProof ? { sandbox_proof: true } : {}),
      ...(params.accessToken ? { access_token: params.accessToken } : {}),
      ...(params.originSurface ? { origin_surface: params.originSurface } : {}),
      ...(params.additionalProduct ? { additional_product: params.additionalProduct } : {}),
      ...(params.selectAccounts ? { select_accounts: true } : {}),
    },
  });
  return { linkToken: link.link_token, platform: surfaceFor(platform), redirectUri };
}

/**
 * On the web an OAuth bank takes the whole page away and returns to the
 * redirect URI, so the pending connect call never resolves. Remember just
 * enough (the link token, never an access token) for the return page to
 * re-open Link and seal the connection. Native keeps Link in its own process
 * and needs none of this.
 */
export function rememberVaultOAuthReturn(params: {
  userId: string;
  link: { linkToken: string; platform: VaultSurface; redirectUri: string | null };
  returnPath?: string;
  successReturnPath?: string;
  originSurface?: "profile_nws" | "agentone_chat";
  onboardingAttemptId?: string;
  relinkItemId?: string;
}): void {
  if (params.link.platform !== "web" || !params.link.redirectUri) return;
  const returnPath =
    params.returnPath ??
    (typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : "/");
  savePlaidOAuthResumeSession({
    userId: params.userId,
    linkToken: params.link.linkToken,
    redirectUri: params.link.redirectUri,
    returnPath,
    ...(params.successReturnPath ? { successReturnPath: params.successReturnPath } : {}),
    ...(params.originSurface ? { originSurface: params.originSurface } : {}),
    ...(params.onboardingAttemptId ? { onboardingAttemptId: params.onboardingAttemptId } : {}),
    ...(params.relinkItemId ? { relinkItemId: params.relinkItemId } : {}),
  });
}

/**
 * Open Plaid Link with a vault link token; resolves the public token, or null
 * on exit. `receivedRedirectUri` resumes a bank's OAuth login on the web.
 */
export async function openVaultPlaidLink(
  linkToken: string,
  options: { receivedRedirectUri?: string } = {},
): Promise<string | null> {
  const Plaid = await loadPlaidLink();
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const handler = Plaid.create({
      token: linkToken,
      ...(options.receivedRedirectUri ? { receivedRedirectUri: options.receivedRedirectUri } : {}),
      onSuccess: (token: string) => {
        if (settled) return;
        settled = true;
        handler.destroy?.();
        resolve(token);
      },
      onExit: (error: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        handler.destroy?.();
        if (error && typeof error === "object" && typeof error.error_message === "string") {
          reject(new Error(error.error_message));
          return;
        }
        resolve(null);
      },
    });
    handler.open();
  });
}
