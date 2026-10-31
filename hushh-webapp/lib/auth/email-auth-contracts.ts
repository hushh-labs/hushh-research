import type { AccountRegistrationRecovery } from "@/lib/auth/account-registration";

/** Public email-auth wire shapes. Codes, bindings and tokens remain memory-only. */
export type EmailChallenge = {
  status: "accepted";
  challenge_id: string;
  expires_at: string;
  resend_at: number;
  destination: string;
};

export type EmailVerification = { status: "authenticated"; custom_token: string }
  | { status: "registration_required"; registration: AccountRegistrationRecovery; enrollment_ticket?: string };

export class EmailAuthRequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "EmailAuthRequestError";
  }
}

export function createEmailBrowserBinding(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
