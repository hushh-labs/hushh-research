/** A Calendar-bound, Contacts-only bearer used for browser-side guest photo reads. */
import { ApiService } from "@/lib/services/api-service";

export const GOOGLE_GUEST_PHOTO_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
export type GooglePhotoPermission = "contacts";
export type GooglePhotoGrant = {
  token: string;
  accountEmail: string;
  subject: string;
  permission: GooglePhotoPermission;
  expiresAt: number;
};

export class GoogleGuestPhotoTokenError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

type PhotoTokenResponse = {
  access_token?: string;
  expires_in?: number;
  account_email?: string;
  subject_sha256?: string;
  grant_generation?: string;
};

type PhotoTokenRequest = {
  idToken: string;
  vaultOwnerToken: string;
  ownerId: string;
  accountId: string;
  accountEmail: string;
  subjectSha256: string;
  grantGeneration: string;
  signal: AbortSignal;
};

/** The server verifies the selected owner/account and Google's exact returned scope. */
export async function requestGoogleInvitationPhotoGrant(input: PhotoTokenRequest): Promise<GooglePhotoGrant> {
  const expectedEmail = input.accountEmail.trim().toLowerCase();
  if (!expectedEmail || !/^[a-f0-9]{64}$/.test(input.subjectSha256)
    || !/^[a-f0-9]{64}$/.test(input.grantGeneration)) {
    throw new Error("The selected Calendar account cannot be verified.");
  }
  const response = await ApiService.apiFetch("/api/one/calendar/guest-photo-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.idToken}`, "X-Hushh-Consent": input.vaultOwnerToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: input.ownerId,
      account_id: input.accountId,
      grant_generation: input.grantGeneration,
      provider_subject_sha256: input.subjectSha256,
    }),
    cache: "no-store",
    signal: input.signal,
  });
  if (!response.ok) throw new GoogleGuestPhotoTokenError(
    "Google guest photos are unavailable for this Calendar connection.",
    response.status === 429 || response.status >= 500,
  );
  const token = await response.json() as PhotoTokenResponse;
  const ttl = Number(token.expires_in);
  if (!token.access_token || token.account_email?.trim().toLowerCase() !== expectedEmail
    || token.subject_sha256 !== input.subjectSha256 || token.grant_generation !== input.grantGeneration
    || !Number.isFinite(ttl) || ttl <= 0 || ttl > 3600) {
    throw new Error("The Calendar photo grant did not match the selected account.");
  }
  return {
    token: token.access_token,
    accountEmail: expectedEmail,
    subject: input.subjectSha256,
    permission: "contacts",
    expiresAt: Date.now() + ttl * 1000,
  };
}
