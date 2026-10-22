"use client";

import {
  getGoogleIdentityServices,
  preloadGoogleIdentityServices,
} from "@/lib/contacts/google-contacts-token";
import { GOOGLE_CONTACTS_READ_SCOPE } from "@/lib/contacts/initial-contact-onboarding-config";

export const GOOGLE_SIGNUP_AUTH_TIMEOUT_MS = 120_000;

const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

export type GoogleSignupToken = {
  accessToken: string;
  contactsGranted: boolean;
};

function googleSignupClientId(): string {
  return String(process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID || "").trim();
}

/** An authentication client must be explicitly configured for Firebase. */
export function googleSignupConfigured(): boolean {
  return Boolean(googleSignupClientId());
}

function authError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizedScopes(scope: string | undefined): Set<string> {
  return new Set(
    String(scope || "")
      .split(/\s+/u)
      .filter(Boolean)
      .map((value) => {
        if (value === "email") return IDENTITY_SCOPES[1];
        if (value === "profile") return IDENTITY_SCOPES[2];
        return value;
      }),
  );
}

/** Loads the existing GIS singleton without opening account or consent UI. */
export function preloadGoogleSignupAuth(): Promise<void> {
  return googleSignupConfigured()
    ? preloadGoogleIdentityServices()
    : Promise.resolve();
}

/**
 * A gesture-bound Google grant for Firebase credential exchange. The same token
 * may read Contacts only when the returned scope confirms that permission.
 * Nothing is persisted or refreshed. The caller must establish the Firebase
 * owner with this credential before using its Contacts permission.
 */
export function requestGoogleSignupToken(options?: {
  includeContacts?: boolean;
  signal?: AbortSignal;
}): Promise<GoogleSignupToken> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("Google sign-in was cancelled.", "AbortError"),
    );
  }
  const clientId = googleSignupClientId();
  if (!clientId) {
    return Promise.reject(authError(
      "auth/operation-not-supported-in-this-environment",
      "Google sign-in is not available in this build.",
    ));
  }
  const oauth2 = getGoogleIdentityServices()?.accounts?.oauth2;
  if (!oauth2) {
    // Do not open a popup after awaiting a cold script load: Safari would lose
    // the tap's activation. A later explicit tap can retry the warmed client.
    void preloadGoogleSignupAuth().catch(() => undefined);
    return Promise.reject(authError(
      "auth/initialization-not-ready",
      "Google sign-in is still getting ready. Try again.",
    ));
  }
  const includeContacts = options?.includeContacts === true;
  const requestedScopes = new Set<string>(IDENTITY_SCOPES);
  if (includeContacts) requestedScopes.add(GOOGLE_CONTACTS_READ_SCOPE);

  return new Promise<GoogleSignupToken>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: GoogleSignupToken) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(
      new DOMException("Google sign-in was cancelled.", "AbortError"),
    );
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(authError(
      "auth/timeout",
      "Google sign-in did not finish. Close its window and try again.",
    )), GOOGLE_SIGNUP_AUTH_TIMEOUT_MS);

    try {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: [...requestedScopes].join(" "),
        include_granted_scopes: false,
        callback: (response) => {
          if (settled) return;
          if (response?.error) {
            finish(authError(
              response.error === "access_denied"
                ? "auth/user-cancelled"
                : "auth/invalid-credential",
              "Google sign-in was not completed. Try again.",
            ));
            return;
          }
          const accessToken = String(response?.access_token || "").trim();
          const granted = normalizedScopes(response?.scope);
          if (
            !accessToken
            || IDENTITY_SCOPES.some((scope) => !granted.has(scope))
            || [...granted].some((scope) => !requestedScopes.has(scope))
          ) {
            finish(authError(
              "auth/invalid-credential",
              "Google did not confirm the requested sign-in permissions. Try again.",
            ));
            return;
          }
          finish(undefined, {
            accessToken,
            contactsGranted: includeContacts && granted.has(GOOGLE_CONTACTS_READ_SCOPE),
          });
        },
        error_callback: (error) => {
          if (settled) return;
          const closed = error?.type === "popup_closed";
          const blocked = error?.type === "popup_failed_to_open";
          finish(authError(
            closed ? "auth/popup-closed-by-user"
              : blocked ? "auth/popup-blocked" : "auth/internal-error",
            closed ? "Google sign-in was cancelled."
              : blocked ? "Your browser blocked Google sign-in. Allow pop-ups and try again."
                : "Could not open Google sign-in. Try again.",
          ));
        },
      });
      client.requestAccessToken({ prompt: "select_account" });
    } catch {
      finish(authError(
        "auth/internal-error",
        "Could not open Google sign-in. Try again.",
      ));
    }
  });
}
