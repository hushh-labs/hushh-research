/** A browser-only, invitation-specific People grant. Never use the Calendar bearer here. */
import { getGoogleIdentityServices, preloadGoogleIdentityServices, isGoogleContactsConsentCancelled } from "@/lib/contacts/google-contacts-token";
import { isNative } from "@/lib/capacitor/platform";

export type GooglePhotoPermission = "contacts" | "directory";
export type GooglePhotoGrant = { token: string; accountEmail: string; subject: string; hostedDomain: string | null; permission: GooglePhotoPermission; expiresAt: number };

const SCOPES = {
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  directory: "https://www.googleapis.com/auth/directory.readonly",
} as const;
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
type TokenResponse = { access_token?: string; error?: string; scope?: string; expires_in?: number };
type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };

export function googleInvitationPhotosAvailable(): boolean {
  return typeof window !== "undefined" && !isNative() && Boolean(process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID?.trim());
}

/** Preload on mount so Safari can open the chooser synchronously from a click. */
export async function preloadGoogleInvitationPhotoAuth(): Promise<void> {
  if (googleInvitationPhotosAvailable()) await preloadGoogleIdentityServices();
}

function exactScopes(value: string | undefined, permission: GooglePhotoPermission): boolean {
  const granted = new Set(String(value || "").split(/\s+/u).filter(Boolean));
  return granted.size === 2 && granted.has(SCOPES[permission]) && granted.has(EMAIL_SCOPE);
}

async function verifiedGoogleIdentity(token: string, signal: AbortSignal): Promise<{ email: string; sub: string; hd: string | null }> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal,
  });
  if (!response.ok) throw new Error("Google could not verify the photo account.");
  const identity = await response.json() as { email?: string; email_verified?: boolean; sub?: string; hd?: string };
  if (identity.email_verified !== true || !identity.sub || !identity.email) {
    throw new Error("Google did not confirm the photo account identity.");
  }
  return { email: identity.email.trim().toLowerCase(), sub: identity.sub, hd: identity.hd?.trim().toLowerCase() || null };
}

async function subjectDigest(subject: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The account chooser is only a hint; verified Google userinfo must match Calendar. */
export async function requestGoogleInvitationPhotoGrant(
  selectedEmail: string,
  selectedSubjectSha256: string,
  selectedHostedDomain: string | null | undefined,
  permission: GooglePhotoPermission,
  signal: AbortSignal,
): Promise<GooglePhotoGrant> {
  const expectedEmail = selectedEmail.trim().toLowerCase();
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (!clientId || !expectedEmail || !/^[a-f0-9]{64}$/.test(selectedSubjectSha256)) throw new Error("The selected Calendar account cannot be verified.");
  if (permission === "directory" && !selectedHostedDomain) throw new Error("Workspace directory photos require a verified Workspace account.");
  const oauth2 = getGoogleIdentityServices()?.accounts?.oauth2;
  if (!oauth2) {
    void preloadGoogleInvitationPhotoAuth().catch(() => undefined);
    throw new Error("Google photo access is getting ready. Try again.");
  }
  const response = await new Promise<TokenResponse>((resolve, reject) => {
    let settled = false;
    const finish = (result?: TokenResponse, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(undefined, new DOMException("Google photo access was cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(undefined, new Error("Google photo permission timed out.")), 120_000);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    try {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: `${SCOPES[permission]} ${EMAIL_SCOPE}`,
        include_granted_scopes: false,
        callback: (value: TokenResponse) => finish(value),
        error_callback: (value: { type?: string }) => {
          const error = new Error(value?.type === "popup_closed" ? "Google photo access was cancelled." : "Google photo permission could not be opened.");
          if (value?.type === "popup_closed") error.name = "AbortError";
          finish(undefined, error);
        },
      }) as TokenClient;
      client.requestAccessToken({ prompt: "select_account" });
    } catch { finish(undefined, new Error("Google photo permission could not be opened.")); }
  });
  if (response.error || !response.access_token || !exactScopes(response.scope, permission)) {
    throw new Error("Google did not grant the exact read-only photo permission.");
  }
  const identity = await verifiedGoogleIdentity(response.access_token, signal);
  if (identity.email !== expectedEmail || await subjectDigest(identity.sub) !== selectedSubjectSha256) {
    throw new Error(`Choose ${selectedEmail} in Google to show photos for this Calendar account.`);
  }
  if (permission === "directory" && identity.hd !== selectedHostedDomain?.trim().toLowerCase()) {
    throw new Error("This Google account is not in the selected Workspace directory.");
  }
  const ttl = Math.min(3600, Math.max(0, Number(response.expires_in) || 0));
  return { token: response.access_token, accountEmail: identity.email, subject: identity.sub, hostedDomain: identity.hd, permission, expiresAt: Date.now() + ttl * 1000 };
}

export { isGoogleContactsConsentCancelled };
