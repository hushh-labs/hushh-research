/**
 * Auth Service - Platform-Aware Authentication
 *
 * Production-grade authentication service that handles:
 * - iOS: Native Google Sign-In and Sign in with Apple via HushhAuth plugin
 * - Android: Native Google Sign-In and Firebase OAuthProvider for Apple
 * - Web: Firebase provider popups; initial Google signup uses GIS credential exchange
 * - Credential sync: Native tokens synced with Firebase for consistent UIDs
 *
 * IMPORTANT: This is the single source of truth for authentication.
 * Components should use this service instead of direct Firebase calls.
 */

import { Capacitor } from "@capacitor/core";
import {
  startDeletionPhoneProof, confirmDeletionPhoneProof, cancelDeletionPhoneProof, mintPhoneClaimIdToken,
  startManualPhoneProof, isManualPhoneProof, withNativePhoneProofStart,
  type PhoneDeletionContext, type PhoneDeletionConfirmation, type PhoneClaimConfirmation,
} from "./phone-deletion-verification";
import { PHONE_CONFLICT_COPY } from "@/lib/auth/phone-conflict-copy";
import { getPhoneReliabilityFlags } from "@/lib/auth/phone-reliability";
import { authenticateCustomToken } from "@/lib/auth/custom-token-auth";
import {
  type ApplicationVerifier,
  type ConfirmationResult,
  GoogleAuthProvider,
  getAdditionalUserInfo,
  OAuthProvider,
  PhoneAuthProvider,
  linkWithCredential,
  linkWithPopup,
  signInWithCredential,
  signInWithPopup,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
  signOut as firebaseSignOut,
  updatePhoneNumber,
  User,
  onAuthStateChanged,
} from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import {
  FirebaseAuthentication,
} from "@capacitor-firebase/authentication";
import { HushhAuth, type AuthUser } from "@/lib/capacitor";
import { authSessionInvalidationCodeFromFirebaseError } from "@/lib/auth/session-invalidation";
import { canReauthenticateIdentityHere } from "@/lib/auth/identity-reauth-capability";
import { toast } from "sonner";
import { GOOGLE_CONTACTS_READ_SCOPE } from "@/lib/contacts/initial-contact-onboarding-config";
import { googleSignupConfigured, requestGoogleSignupToken } from "@/lib/auth/google-signup-token";
import { firebaseUidForOwner, lastAdmittedOwnerFor, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

export type GoogleSignInOptions = {
  purpose?: "authentication" | "initial_contacts";
  includeContacts?: boolean;
  signal?: AbortSignal;
  onCredentialExchange?: () => void;
};

export type InitialGoogleContactsGrant = {
  accessToken: string;
  authority: "firebase-signup" | "ios-sdk-grant" | "android-contacts-only";
  googleSubject?: string;
  grantedScopes?: string[];
  expiresAt?: number | null;
};

export interface AuthResult {
  user: User;
  idToken: string;
  accessToken?: string;
  isNewUser?: boolean;
  /** Invocation-local; consumed by the initial reader, never persisted. */
  contactsGrant?: InitialGoogleContactsGrant;
  contactsUnavailable?: boolean;
}

export interface PhoneVerificationStartResult {
  autoVerified: boolean;
  confirmationResult?: ConfirmationResult;
  verificationId?: string;
  user?: User | null;
}

type PhoneVerificationIntent = "link" | "replace";
const LOCAL_DEV_PHONE_VERIFICATION_ID_PREFIX = "local-dev-phone:";
const LOCAL_DEV_PHONE_VERIFICATION_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);
const UAT_PHONE_TEST_VERIFICATION_ID_PREFIX = "uat-test-phone:";
type AuthProviderName = "google" | "apple" | "microsoft";
const EXPECTED_POPUP_CLOSE_CODES = new Set([
  "auth/cancelled-popup-request",
  "auth/popup-closed-by-user",
  "auth/user-cancelled",
]);

/**
 * Platform-aware authentication service
 */
/**
 * Ceiling for one Firebase ID-token refresh. Generous against a slow network
 * (a healthy refresh is a few hundred milliseconds), tight against a hung one.
 */
export const ID_TOKEN_TIMEOUT_MS = 8_000;

export class IdTokenTimeoutError extends Error {
  constructor() {
    super("Firebase ID token refresh timed out");
    this.name = "IdTokenTimeoutError";
  }
}

/** Resolve with the token, or reject with `IdTokenTimeoutError` when it stalls. */
export function withIdTokenTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new IdTokenTimeoutError()), ID_TOKEN_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class AuthService {
  private static isExpectedPopupClose(error: unknown): boolean {
    if (!error || typeof error !== "object" || !("code" in error)) {
      return false;
    }
    return EXPECTED_POPUP_CLOSE_CODES.has(
      String((error as { code?: unknown }).code || ""),
    );
  }

  private static createWebProvider(provider: AuthProviderName) {
    if (provider === "google") {
      const googleProvider = new GoogleAuthProvider();
      googleProvider.setCustomParameters({ prompt: "select_account" });
      return googleProvider;
    }
    if (provider === "microsoft") {
      const microsoftProvider = new OAuthProvider("microsoft.com");
      microsoftProvider.setCustomParameters({ prompt: "select_account", tenant: "common" });
      return microsoftProvider;
    }
    const appleProvider = new OAuthProvider("apple.com");
    appleProvider.addScope("email");
    appleProvider.addScope("name");
    return appleProvider;
  }
  private static debugLog(...args: unknown[]) {
    if (process.env.NODE_ENV !== "production") {
      console.log(...args);
    }
  }

  private static debugError(label: string, error?: unknown) {
    if (process.env.NODE_ENV !== "production" && error !== undefined) {
      console.error(label, error);
      return;
    }
    console.error(label);
  }

  private static async pause(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Bounded token fetch that tolerates a Firebase session still restoring
   * (common a few frames after a fresh Google/Apple sign-in or a referral
   * redirect). One short wait-and-retry only -- never an unbounded loop --
   * so a genuinely signed-out caller still fails fast.
   */
  static async getIdTokenWithRetry(options?: {
    retries?: number;
    delayMs?: number;
    expectedUserId?: string;
  }): Promise<string | null> {
    const retries = options?.retries ?? 1;
    const delayMs = options?.delayMs ?? 400;
    const expectedUserId = String(options?.expectedUserId || "").trim();
    const accept = (candidate: string | null): string | null => {
      if (!candidate) return null;
      if (
        expectedUserId &&
        !this.idTokenBelongsToUser(candidate, expectedUserId)
      ) {
        return null;
      }
      return candidate;
    };
    let token = accept(await this.getIdToken());
    for (let attempt = 0; !token && attempt < retries; attempt += 1) {
      await this.pause(delayMs);
      token = accept(await this.getIdToken());
    }
    return token;
  }

  private static getLocalDevPhoneTestConfig(): {
    phoneNumber: string;
    verificationCode: string;
  } | null {
    if (
      process.env.NEXT_PUBLIC_APP_ENV !== "development" ||
      process.env.NEXT_PUBLIC_FIREBASE_PHONE_AUTH_DISABLE_APP_VERIFICATION !==
        "true"
    ) {
      return null;
    }

    const phoneNumber = String(
      process.env.NEXT_PUBLIC_FIREBASE_PHONE_AUTH_LOCAL_TEST_PHONE || "",
    ).trim();
    const verificationCode = String(
      process.env.NEXT_PUBLIC_FIREBASE_PHONE_AUTH_LOCAL_TEST_CODE || "",
    ).trim();

    if (!phoneNumber || !verificationCode) {
      return null;
    }

    return { phoneNumber, verificationCode };
  }

  private static isLocalDevPhoneHost(): boolean {
    if (typeof window === "undefined") {
      return false;
    }

    return LOCAL_DEV_PHONE_VERIFICATION_HOSTS.has(
      window.location.hostname.toLowerCase(),
    );
  }

  static shouldUseLocalDevPhoneVerification(phoneNumber: string): boolean {
    const config = this.getLocalDevPhoneTestConfig();
    return (
      Boolean(config) &&
      this.isLocalDevPhoneHost() &&
      String(phoneNumber ?? "").trim() === config?.phoneNumber
    );
  }

  static isLocalDevPhoneVerificationId(
    verificationId?: string | null,
  ): boolean {
    return String(verificationId ?? "").startsWith(
      LOCAL_DEV_PHONE_VERIFICATION_ID_PREFIX,
    );
  }

  static isUatPhoneTestVerificationId(verificationId?: string | null): boolean {
    return String(verificationId ?? "").startsWith(
      UAT_PHONE_TEST_VERIFICATION_ID_PREFIX,
    );
  }

  private static createLocalDevPhoneVerificationId(
    phoneNumber: string,
  ): string {
    return `${LOCAL_DEV_PHONE_VERIFICATION_ID_PREFIX}${encodeURIComponent(phoneNumber)}`;
  }

  private static getPhoneNumberFromLocalDevVerificationId(
    verificationId: string,
  ): string | null {
    if (!this.isLocalDevPhoneVerificationId(verificationId)) {
      return null;
    }

    try {
      return decodeURIComponent(
        verificationId.slice(LOCAL_DEV_PHONE_VERIFICATION_ID_PREFIX.length),
      );
    } catch {
      return null;
    }
  }

  static async confirmLocalDevPhoneVerification(params: {
    verificationCode: string;
    verificationId?: string | null;
  }): Promise<User> {
    const verificationId = String(params.verificationId ?? "").trim();
    const verificationCode = String(params.verificationCode ?? "").trim();
    const phoneNumber =
      this.getPhoneNumberFromLocalDevVerificationId(verificationId);
    const config = this.getLocalDevPhoneTestConfig();

    if (
      !config ||
      !phoneNumber ||
      phoneNumber !== config.phoneNumber ||
      !this.isLocalDevPhoneHost()
    ) {
      throw this.createPhoneVerificationError(
        "local-phone-test-disabled",
        "Local phone verification is not enabled for this phone number.",
      );
    }

    if (verificationCode !== config.verificationCode) {
      throw this.createPhoneVerificationError(
        "invalid-verification-code",
        "Invalid local test verification code.",
      );
    }

    if (!auth.currentUser) {
      throw new Error("You must be signed in before linking a phone number.");
    }

    return auth.currentUser;
  }

  private static decodeJwtPayload(
    token: string,
  ): Record<string, unknown> | null {
    const normalized = String(token || "").trim();
    if (!normalized) return null;
    const parts = normalized.split(".");
    if (parts.length < 2) return null;
    const payloadSegment = parts[1];
    if (!payloadSegment) return null;

    try {
      const base64 = payloadSegment
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(payloadSegment.length / 4) * 4, "=");
      if (typeof atob !== "function") {
        return null;
      }
      const json = atob(base64);
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private static isUsableIdToken(
    token: string | null | undefined,
    minRemainingMs = 60_000,
  ): boolean {
    const normalized = String(token || "").trim();
    if (!normalized) return false;
    const payload = this.decodeJwtPayload(normalized);
    const expSeconds =
      typeof payload?.exp === "number"
        ? payload.exp
        : typeof payload?.exp === "string"
          ? Number(payload.exp)
          : NaN;
    if (!Number.isFinite(expSeconds) || expSeconds <= 0) {
      return false;
    }
    return expSeconds * 1000 - Date.now() > minRemainingMs;
  }

  private static idTokenSubject(token: string): string | null {
    const payload = this.decodeJwtPayload(token);
    const subject =
      typeof payload?.user_id === "string"
        ? payload.user_id
        : typeof payload?.sub === "string"
          ? payload.sub
          : "";
    return subject.trim() || null;
  }

  private static idTokenBelongsToUser(
    token: string,
    expectedUserId: string,
  ): boolean {
    // Callers may name the session by its application owner; tokens carry the Firebase UID.
    return this.idTokenSubject(token) === firebaseUidForOwner(expectedUserId);
  }

  private static nativeIdentityMismatchError(expectedUserId: string): Error {
    return Object.assign(
      new Error("Native authentication token does not match the restored user."),
      {
        code: "auth/invalid-user-token",
        userId: expectedUserId,
      },
    );
  }

  private static nativeRestoreTerminalError(
    error: unknown,
    userId: string,
  ): Error {
    return Object.assign(new Error("Native session is no longer valid."), {
      cause: error,
      userId,
    });
  }

  private static getNativeUserField(
    nativeUser: Record<string, unknown> | null | undefined,
    keys: string[],
  ): string {
    if (!nativeUser) return "";
    for (const key of keys) {
      const value = nativeUser[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return "";
  }

  private static async resolveLiveNativeIdToken(
    initialToken: string,
    forceRefresh = false,
    expectedUserId = "",
  ): Promise<string> {
    const nativeTokenOptions = forceRefresh
      ? { forceRefresh: true }
      : undefined;
    let forcedRefreshError: unknown = null;
    let identityMismatch = Boolean(
      expectedUserId &&
        this.isUsableIdToken(initialToken) &&
        !this.idTokenBelongsToUser(initialToken, expectedUserId),
    );
    const firebaseUser = auth.currentUser;
    if (firebaseUser && (!expectedUserId || firebaseUser.uid === firebaseUidForOwner(expectedUserId))) {
      try {
        const token = await firebaseUser.getIdToken(forceRefresh);
        if (!expectedUserId || this.idTokenBelongsToUser(token, expectedUserId)) {
          return token;
        }
        identityMismatch = true;
      } catch (error) {
        if (
          forceRefresh &&
          authSessionInvalidationCodeFromFirebaseError(error) !== null
        ) {
          throw error;
        }
        if (forceRefresh) forcedRefreshError = error;
        this.debugError(
          "[AuthService] Failed to get Firebase JS token during native resolution",
          error,
        );
      }
    } else if (firebaseUser && expectedUserId) {
      identityMismatch = true;
    }

    try {
      const result = await FirebaseAuthentication.getIdToken(nativeTokenOptions);
      if (
        result.token &&
        this.isUsableIdToken(result.token) &&
        (!expectedUserId ||
          this.idTokenBelongsToUser(result.token, expectedUserId))
      ) {
        return result.token;
      }
      if (result.token && expectedUserId) identityMismatch = true;
    } catch (error) {
      if (
        forceRefresh &&
        authSessionInvalidationCodeFromFirebaseError(error) !== null
      ) {
        throw error;
      }
      if (forceRefresh) forcedRefreshError = error;
      this.debugError(
        "[AuthService] FirebaseAuthentication token lookup failed",
        error,
      );
    }

    try {
      const result = await HushhAuth.getIdToken(nativeTokenOptions);
      if (
        result.idToken &&
        this.isUsableIdToken(result.idToken) &&
        (!expectedUserId ||
          this.idTokenBelongsToUser(result.idToken, expectedUserId))
      ) {
        return result.idToken;
      }
      if (result.idToken && expectedUserId) identityMismatch = true;
    } catch (error) {
      if (
        forceRefresh &&
        authSessionInvalidationCodeFromFirebaseError(error) !== null
      ) {
        throw error;
      }
      if (forceRefresh) forcedRefreshError = error;
      this.debugError("[AuthService] HushhAuth token lookup failed", error);
    }

    if (forceRefresh) {
      if (identityMismatch && expectedUserId) {
        throw this.nativeIdentityMismatchError(expectedUserId);
      }
      if (forcedRefreshError) throw forcedRefreshError;
      return "";
    }

    if (
      this.isUsableIdToken(initialToken) &&
      (!expectedUserId ||
        this.idTokenBelongsToUser(initialToken, expectedUserId))
    ) {
      return initialToken;
    }
    if (identityMismatch && expectedUserId) {
      throw this.nativeIdentityMismatchError(expectedUserId);
    }
    return "";
  }

  /**
   * Sign-in never asks for Google Contacts. The sensitive scope on the login
   * consent screen made Google flag the sign-in as unverified; contacts are
   * requested later, on demand, through the separate contacts token.
   */
  static canRequestInitialGoogleContacts(): boolean {
    return false;
  }

  /**
   * Sign in with Google using the appropriate method for the current platform.
   *
   * iOS: Uses @capacitor-firebase/authentication plugin
   * Web: Uses Firebase signInWithPopup directly
   *
   * @returns Firebase User object (consistent on both platforms)
   */
  static async signInWithGoogle(options?: GoogleSignInOptions): Promise<AuthResult> {
    // Contacts is still awaiting public OAuth verification. Keep production
    // authentication usable; new-account welcome enrollment remains independent.
    const effectiveOptions: GoogleSignInOptions | undefined =
      options?.purpose === "initial_contacts" && !this.canRequestInitialGoogleContacts()
        ? { ...options, purpose: "authentication" }
        : options;
    if (Capacitor.isNativePlatform()) {
      return this.nativeGoogleSignIn(effectiveOptions);
    } else {
      return this.webGoogleSignIn(effectiveOptions);
    }
  }

  /** Source routing only; never infer a native sign-in from linked JS providers. */
  static async initialContactsSignInProvider(user: User, isCurrent: () => boolean): Promise<string | null> {
    if (!isCurrent()) throw new Error("session_changed");
    if (!Capacitor.isNativePlatform()) {
      const result = await user.getIdTokenResult();
      if (!isCurrent()) throw new Error("session_changed");
      return result.signInProvider;
    }
    let metadata: Awaited<ReturnType<typeof FirebaseAuthentication.getIdTokenResult>> | null = null;
    try { metadata = await FirebaseAuthentication.getIdTokenResult(); } catch { /* Older shells use the owner-checked native token fallback. */ }
    if (metadata) {
      if (!isCurrent() || String(metadata.claims.sub ?? metadata.claims.user_id ?? "") !== user.uid) throw new Error("session_changed");
      return metadata.signInProvider;
    }
    const token = (await HushhAuth.getIdToken()).idToken ?? "";
    if (!isCurrent() || !this.idTokenBelongsToUser(token, user.uid)) throw new Error("session_changed");
    const firebase = this.decodeJwtPayload(token)?.firebase as { sign_in_provider?: string } | undefined;
    return typeof firebase?.sign_in_provider === "string" ? firebase.sign_in_provider : null;
  }

  /** Existing One session; the server resolves the linked delivery identity. */
  static async documentRequestIdentityToken(
    expectedUserId: string,
    isCurrent: () => boolean,
  ): Promise<string> {
    if (!expectedUserId || !isCurrent()) throw new Error("session_changed");
    if (Capacitor.isNativePlatform()) {
      const token = await this.resolveLiveNativeIdToken("", true, expectedUserId);
      if (!isCurrent()) throw new Error("session_changed");
      if (!token) throw new Error("identity_verification_failed");
      return token;
    }
    const user = auth.currentUser;
    if (!user || user.uid !== firebaseUidForOwner(expectedUserId)) throw new Error("session_changed");
    const token = await user.getIdToken(true);
    if (!isCurrent() || auth.currentUser !== user) throw new Error("session_changed");
    return token;
  }

  /** Explicit one-time account linking. Never switches or merges One accounts. */
  static async linkGoogleIdentity(
    expectedUserId: string,
    isCurrent: () => boolean,
  ): Promise<string> {
    if (!expectedUserId || !isCurrent()) throw new Error("session_changed");
    try {
      if (Capacitor.isNativePlatform()) {
        throw new Error("identity_link_web_required");
      } else {
        const user = auth.currentUser;
        const firebaseUid = firebaseUidForOwner(expectedUserId);
        if (!user || user.uid !== firebaseUid) throw new Error("session_changed");
        if (user.providerData?.some((provider) => provider.providerId === "google.com")) {
          return await this.documentRequestIdentityToken(expectedUserId, isCurrent);
        }
        // Keep the popup on the explicit Add Google account gesture.
        const result = await linkWithPopup(user, this.createWebProvider("google"));
        if (!isCurrent() || auth.currentUser !== user || result.user.uid !== firebaseUid) throw new Error("session_changed");
      }
      return await this.documentRequestIdentityToken(expectedUserId, isCurrent);
    } catch (error) {
      if (!isCurrent() || error instanceof Error && error.message === "session_changed") throw new Error("session_changed");
      if (error instanceof Error && error.message === "identity_link_web_required") throw error;
      if (this.isExpectedPopupClose(error)) throw new Error("identity_cancelled");
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "auth/credential-already-in-use" || code === "auth/account-exists-with-different-credential") throw new Error("identity_already_linked");
      if (code === "auth/popup-blocked") throw new Error("identity_popup_blocked");
      throw new Error("identity_verification_failed");
    }
  }

  private static async reauthenticateNativeIdentity(
    provider: "google" | "apple", expectedUserId: string, isCurrent: () => boolean,
  ): Promise<string> {
    if (!expectedUserId || !isCurrent()) throw new Error("session_changed");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        provider === "google" ? HushhAuth.reauthenticateGoogleIdentity({ expectedUserId })
          : HushhAuth.reauthenticateAppleIdentity({ expectedUserId }),
        // Bound older wrappers whose missing bridge method never settles.
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("identity_timeout")), 125_000);
        }),
      ]);
      if (!isCurrent()) throw new Error("session_changed");
      if (result.userId !== expectedUserId) throw new Error("identity_mismatch");
      if (typeof result.idToken !== "string" || !result.idToken.trim()) throw new Error("identity_verification_failed");
      return result.idToken;
    } catch (error) {
      if (!isCurrent()) throw new Error("session_changed");
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const safeCode = code || (error instanceof Error ? error.message : "");
      if (code === "UNIMPLEMENTED" || code === "UNAVAILABLE") throw new Error("native_identity_unavailable");
      if (["identity_cancelled", "identity_mismatch", "google_identity_required", "apple_identity_required", "session_changed", "identity_busy", "identity_timeout"].includes(safeCode)) throw new Error(safeCode);
      throw new Error("identity_verification_failed");
    } finally { clearTimeout(deadline); }
  }

  /** Fresh Google proof for an existing owner, never a replacement sign-in. */
  static async reauthenticateGoogleIdentity(
    expectedUserId: string,
    isCurrent: () => boolean,
  ): Promise<string> {
    return this.reauthenticateGoogleProof(expectedUserId, isCurrent, false);
  }

  private static async reauthenticateGoogleProof(
    expectedUserId: string,
    isCurrent: () => boolean,
    directWebGrant: boolean,
  ): Promise<string> {
    if (!expectedUserId || !isCurrent()) throw new Error("session_changed");
    // Callers may name the session by its application owner; provider proofs bind the Firebase UID.
    const firebaseUid = firebaseUidForOwner(expectedUserId);
    if (Capacitor.isNativePlatform()) {
      return this.reauthenticateNativeIdentity("google", firebaseUid, isCurrent);
    }
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== firebaseUid ||
        !currentUser.providerData.some((provider) => provider.providerId === "google.com")) {
      throw new Error("google_identity_required");
    }
    const assertCurrent = () => {
      if (!isCurrent() || auth.currentUser !== currentUser || currentUser.uid !== firebaseUid) throw new Error("session_changed");
    };
    assertCurrent();
    try {
      const result = await (async () => {
        if (!directWebGrant || !googleSignupConfigured()) {
          // No await before Firebase receives the originating user gesture.
          return reauthenticateWithPopup(currentUser, this.createWebProvider("google"));
        }
        // Reuse sign-in's direct Google transport: the hosted Firebase popup
        // can lose its return event in mobile browsers. Reauthentication must
        // prove this existing user, never replace the session with sign-in.
        const grant = await requestGoogleSignupToken({ includeContacts: false });
        assertCurrent();
        // Request the original tab as soon as Google's grant settles, while
        // the initiating owner and verification attempt are still current.
        try {
          window.focus();
        } catch {
          // Browser focus cannot block identity proof.
        }
        return reauthenticateWithCredential(
          currentUser,
          GoogleAuthProvider.credential(null, grant.accessToken),
        );
      })();
      assertCurrent();
      if (result.user.uid !== firebaseUid) throw new Error("identity_mismatch");
      const token = await result.user.getIdToken(true);
      assertCurrent();
      return token;
    } catch (error) {
      assertCurrent();
      if (this.isExpectedPopupClose(error)) throw new Error("identity_cancelled");
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "auth/popup-blocked") throw new Error("identity_popup_blocked");
      if (code === "auth/initialization-not-ready") throw new Error("identity_initialization_not_ready");
      if (code === "auth/timeout") throw new Error("identity_timeout");
      if (code === "auth/user-mismatch" || error instanceof Error && error.message === "identity_mismatch") throw new Error("identity_mismatch");
      // No OAuth payload/credential or Firebase error object crosses this seam.
      throw new Error("identity_verification_failed");
    }
  }

  /** Fresh provider proof for irreversible account deletion; never signs in another user. */
  static async reauthenticateAccountDeletionIdentity(
    expectedUserId: string,
    providerId: "google.com" | "apple.com",
    isCurrent: () => boolean,
  ): Promise<string> {
    if (providerId === "google.com") {
      return this.reauthenticateGoogleProof(expectedUserId, isCurrent, true);
    }
    return this.reauthenticateIdentity(expectedUserId, providerId, isCurrent);
  }

  /** Fresh current-user provider proof; ordinary token refresh is insufficient. */
  static async reauthenticateIdentity(
    expectedUserId: string,
    providerId: "google.com" | "apple.com" | "microsoft.com",
    isCurrent: () => boolean,
  ): Promise<string> {
    if (providerId === "google.com") {
      return this.reauthenticateGoogleIdentity(expectedUserId, isCurrent);
    }
    // Callers may name the session by its application owner; provider proofs bind the Firebase UID.
    const firebaseUid = firebaseUidForOwner(expectedUserId);
    if (!canReauthenticateIdentityHere(providerId)) throw new Error("native_identity_unavailable");
    if (Capacitor.isNativePlatform()) return this.reauthenticateNativeIdentity("apple", firebaseUid, isCurrent);
    const currentUser = auth.currentUser;
    if (!expectedUserId || !isCurrent() || !currentUser ||
        currentUser.uid !== firebaseUid ||
        !currentUser.providerData.some((provider) => provider.providerId === providerId)) {
      throw new Error(providerId === "apple.com" ? "apple_identity_required" : "microsoft_identity_required");
    }
    const assertCurrent = () => {
      if (!isCurrent() || auth.currentUser !== currentUser || currentUser.uid !== firebaseUid) {
        throw new Error("session_changed");
      }
    };
    assertCurrent();
    try {
      const result = await reauthenticateWithPopup(currentUser, this.createWebProvider(providerId === "apple.com" ? "apple" : "microsoft"));
      assertCurrent();
      if (result.user.uid !== firebaseUid) throw new Error("identity_mismatch");
      const token = await result.user.getIdToken(true);
      assertCurrent();
      return token;
    } catch (error) {
      assertCurrent();
      if (this.isExpectedPopupClose(error)) throw new Error("identity_cancelled");
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "auth/popup-blocked") throw new Error("identity_popup_blocked");
      if (code === "auth/user-mismatch" || error instanceof Error && error.message === "identity_mismatch") {
        throw new Error("identity_mismatch");
      }
      throw new Error("identity_verification_failed");
    }
  }

  /**
   * Sign in with Email and Password using appropriate method for platform.
   * On Native: Uses @capacitor-firebase/authentication for Keychain persistence.
   * On Web: Uses Firebase JS SDK directly.
   */
  static async signInWithEmailAndPassword(
    email: string,
    password: string,
  ): Promise<AuthResult> {
    if (Capacitor.isNativePlatform()) {
      this.debugLog("🍎 [AuthService] Starting native Email/Password Sign-In");
      const toastId = toast.loading("Signing in as reviewer...");

      try {
        const result = await FirebaseAuthentication.signInWithEmailAndPassword({
          email,
          password,
        });

        if (!result.user) {
          throw new Error("No user returned from native email/password login");
        }

        const idTokenResult = await FirebaseAuthentication.getIdToken();
        const idToken = idTokenResult.token || "";

        this.debugLog("✅ [AuthService] Native email/password complete");

        // Wait for JS SDK to see the change (usually happens automatically but we can force)
        let firebaseUser = auth.currentUser;
        if (!firebaseUser) {
          // Small delay to let sync happen
          await new Promise((resolve) => setTimeout(resolve, 500));
          firebaseUser = auth.currentUser;
        }

        const user =
          firebaseUser ||
          this.createUserFromNative(result.user, idToken, "password");
        toast.success("Signed in successfully", { id: toastId });

        return {
          user,
          idToken,
        };
      } catch (error: any) {
        this.debugError("❌ [AuthService] Native email/password failed", error);
        toast.error(error.message || "Failed to sign in", { id: toastId });
        throw error;
      }
    } else {
      // WEB FLOW
      const { signInWithEmailAndPassword: webSignIn } =
        await import("firebase/auth");
      const result = await webSignIn(auth, email, password);
      const idToken = await result.user.getIdToken();
      return {
        user: result.user,
        idToken,
      };
    }
  }

  /**
   * Sign in with Firebase custom token.
   *
   * Used for app-review mode where backend mints a short-lived token
   * for a pre-approved reviewer UID. No reviewer password is exposed to clients.
   */
  static async signInWithCustomToken(customToken: string, options: { memoryOnly?: boolean } = {}): Promise<AuthResult> {
    return authenticateCustomToken(customToken, options,
      (user, idToken) => this.createUserFromNative(user, idToken, "custom"));
  }

  /**
   * Native iOS/Android Google Sign-In flow using @capacitor-firebase/authentication
   * 1. FirebaseAuthentication.signInWithGoogle() presents native Google UI
   * 2. Automatically syncs with Firebase
   * 3. Returns authenticated user
   *
   * Falls back to web auth if native plugin is not available
   */
  /**
   * Safety net for the Android bridge. The native plugin already settles
   * every provider, Firebase, and exchange-deadline path; this bound only
   * guarantees the sign-in UI can never wait forever on an older shell.
   * It is generous because the account picker itself is user-paced.
   */
  static readonly ANDROID_GOOGLE_SIGN_IN_TIMEOUT_MS = 180_000;

  private static async boundedAndroidGoogleSignIn(): ReturnType<
    typeof HushhAuth.signIn
  > {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        HushhAuth.signIn(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error("Google sign-in is taking too long. Check your connection and try again."),
                  { code: "auth/timeout" },
                ),
              ),
            this.ANDROID_GOOGLE_SIGN_IN_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Maps HushhAuth bridge rejections to the codes the sign-in UI handles. */
  private static normalizeAndroidGoogleSignInError(
    error: unknown,
  ): Error & { code: string } {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Google sign-in failed. Please try again.";
    if (code === "USER_CANCELLED") {
      return Object.assign(new Error("Sign in cancelled"), {
        code: "auth/user-cancelled",
      });
    }
    if (code === "auth/network-request-failed") {
      return Object.assign(
        new Error("Network error. Check your connection and try again."),
        { code },
      );
    }
    if (code === "auth/timeout") {
      return Object.assign(
        new Error("Google sign-in is taking too long. Check your connection and try again."),
        { code },
      );
    }
    return Object.assign(new Error(message), {
      code: code || "auth/google-sign-in-failed",
    });
  }

  private static async nativeGoogleSignIn(options?: GoogleSignInOptions): Promise<AuthResult> {
    this.debugLog(
      "🍎 [AuthService] Starting native Google Sign-In via FirebaseAuthentication",
    );
    const toastId = toast.loading("Signing in with Google...");

    try {
      this.debugLog(
        "🍎 [AuthService] Calling FirebaseAuthentication.signInWithGoogle()...",
      );

      // The Capawesome Android Google provider can return to the WebView
      // without settling its saved Capacitor call when the provider activity
      // is recreated. HusshAuth owns an ActivityResultLauncher and the
      // Firebase exchange on Android, so use that native contract there.
      // iOS keeps the Capawesome path, which is its canonical implementation.
      let nativeAuthUser: AuthUser | NonNullable<
        Awaited<
          ReturnType<typeof FirebaseAuthentication.signInWithGoogle>
        >["user"]
      >;
      let idToken = "";
      let accessToken: string | undefined;
      let isNewUser: boolean | undefined;
      if (Capacitor.getPlatform() === "android") {
        const result = await this.boundedAndroidGoogleSignIn();
        nativeAuthUser = result.user;
        idToken = result.idToken;
        accessToken = result.accessToken;
        isNewUser = result.isNewUser;
      } else {
        const result = options?.purpose === "initial_contacts"
          ? await FirebaseAuthentication.signInWithGoogle({ scopes: [GOOGLE_CONTACTS_READ_SCOPE] })
          : await FirebaseAuthentication.signInWithGoogle();
        if (!result.user) {
          throw new Error("Invalid response from native sign-in");
        }
        nativeAuthUser = result.user;
        const nativeIdTokenResult =
          await FirebaseAuthentication.getIdToken();
        idToken =
          nativeIdTokenResult.token || result.credential?.idToken || "";
        accessToken = result.credential?.accessToken;
        isNewUser = result.additionalUserInfo?.isNewUser;
      }

      this.debugLog("✅ [AuthService] Native sign-in returned result");

      if (!nativeAuthUser) {
        this.debugError(
          "❌ [AuthService] Invalid response from native sign-in",
        );
        toast.error("Invalid native auth response", { id: toastId });
        throw new Error("Invalid response from native sign-in");
      }

      this.debugLog("✅ [AuthService] Got native ID token");

      // Step 3: Sync with Firebase JS SDK if needed
      // The native plugin already signed in to Firebase on the native layer.
      // We usually want the JS layer to also know about it for consistency.
      let firebaseUser = auth.currentUser;
      const nativeUid = this.getNativeUserField(nativeAuthUser as unknown as Record<string, unknown>, ["uid", "id"]);
      const staleJsOwner = Boolean(firebaseUser && firebaseUser.uid !== nativeUid);
      if (staleJsOwner) firebaseUser = null;

      if (!firebaseUser && !staleJsOwner && idToken && accessToken) {
        this.debugLog("🔄 [AuthService] Syncing with Firebase JS SDK...");

        // We need a credential to sign in the JS SDK.
        // We have the Google ID Token and Access Token from the native result.
        const credential = GoogleAuthProvider.credential(idToken, accessToken);

        try {
          // Wrapped in a timeout to prevent hanging on iOS
          const syncPromise = signInWithCredential(auth, credential);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("JS SDK Sync Timed Out")), 5000),
          );

          const firebaseResult = (await Promise.race([
            syncPromise,
            timeoutPromise,
          ])) as any;
          firebaseUser = firebaseResult.user;
          this.debugLog("✅ [AuthService] Firebase JS SDK synced");
        } catch (syncError) {
          this.debugError(
            "⚠️ [AuthService] JS SDK Sync Failed/Timed Out",
            syncError,
          );
          // Don't show error toast to user as this is a background sync issue
          // toast.error("JS SDK Sync Failed (proceeding with native user)");
          this.debugLog("⚠️ Proceeding with Native User anyway.");
        }
      }

      // Construct final User object
      // If JS SDK failed, we wrap the native user information into a Firebase-like User object
      const user =
        firebaseUser || this.createUserFromNative(nativeAuthUser, idToken);

      toast.success("Signed in successfully", { id: toastId });

      // Contacts authorization is separate from a successful Firebase login.
      // Android's legacy accessToken alias is deliberately never used here.
      let contactsGrant: InitialGoogleContactsGrant | undefined;
      let contactsUnavailable = false;
      if (options?.purpose === "initial_contacts" && isNewUser !== false) {
        try {
          const grant = await HushhAuth.authorizeGoogleContacts({ expectedUserId: user.uid });
          if (!grant.accessToken || !grant.grantedScopes.includes(GOOGLE_CONTACTS_READ_SCOPE)) {
            throw new Error("contacts_not_granted");
          }
          contactsGrant = grant;
        } catch {
          // Older shells, cancellation and source failures do not undo login.
          contactsUnavailable = true;
        }
      }
      return {
        user,
        idToken,
        accessToken,
        isNewUser,
        contactsGrant,
        contactsUnavailable,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.debugError("❌ [AuthService] nativeGoogleSignIn error");

      if (Capacitor.getPlatform() === "android") {
        const androidError = this.normalizeAndroidGoogleSignInError(error);
        if (androidError.code === "auth/user-cancelled") {
          toast.dismiss(toastId);
        } else {
          toast.error(androidError.message, { id: toastId });
        }
        throw androidError;
      }

      // If native plugin not implemented, fall back to web auth
      if (
        errorMessage.includes("not implemented") ||
        errorMessage.includes("not available")
      ) {
        this.debugLog(
          "⚠️ [AuthService] Native plugin not available, falling back to web auth",
        );
        toast.dismiss(toastId); // Dismiss loading before switching
        return this.webGoogleSignIn(options);
      }

      toast.error("Sign in failed: " + errorMessage, { id: toastId });
      this.debugError("❌ [AuthService] Native sign-in failed", error);
      throw error;
    }
  }

  /**
   * Create a User-like object from native Firebase user information
   */
  private static createUserFromNative(
    nativeUser: any,
    idToken: string,
    providerId: string = "google.com",
  ): User {
    const uid = this.getNativeUserField(nativeUser, ["uid", "id"]);
    const email = this.getNativeUserField(nativeUser, ["email"]);
    const displayName = this.getNativeUserField(nativeUser, ["displayName"]);
    const photoURL = this.getNativeUserField(nativeUser, [
      "photoUrl",
      "photoURL",
    ]);
    const phoneNumber = this.getNativeUserField(nativeUser, ["phoneNumber"]);
    const emailVerified =
      typeof nativeUser?.emailVerified === "boolean"
        ? nativeUser.emailVerified
        : true;
    const liveTokenProvider = async (forceRefresh = false) =>
      this.resolveLiveNativeIdToken(idToken, forceRefresh, uid);

    return {
      uid,
      email,
      displayName,
      photoURL,
      emailVerified,
      isAnonymous: false,
      metadata: {
        creationTime: new Date().toISOString(),
        lastSignInTime: new Date().toISOString(),
      },
      providerData: [
        {
          providerId,
          uid,
          displayName,
          email,
          phoneNumber: phoneNumber || null,
          photoURL,
        },
      ],
      refreshToken: "",
      tenantId: null,
      delete: async () => {},
      getIdToken: async (forceRefresh?: boolean) =>
        liveTokenProvider(Boolean(forceRefresh)),
      getIdTokenResult: async () => {
        const liveToken = await liveTokenProvider();
        const claims = this.decodeJwtPayload(liveToken) ?? {};
        const firebase = claims.firebase as { sign_in_provider?: string } | undefined;
        return {
          token: liveToken,
          claims,
          authTime: "",
          issuedAtTime: "",
          expirationTime: "",
          signInProvider: firebase?.sign_in_provider ?? providerId,
          signInSecondFactor: null,
        };
      },
      reload: async () => {},
      toJSON: () => ({}),
      phoneNumber: phoneNumber || null,
      providerId,
    } as unknown as User;
  }

  /**
   * Web Google Sign-In flow
   * Initial web signup exchanges a GIS token directly when its identity client
   * is configured. The existing Firebase popup remains the compatibility path.
   */
  private static async webGoogleSignIn(options?: GoogleSignInOptions): Promise<AuthResult> {
    this.debugLog(
      "🌐 [AuthService] Starting web Google Sign-In",
    );

    try {
      if (options?.purpose && googleSignupConfigured()) {
        // A hosted Firebase popup can close after Google's successful consent
        // without delivering its auth event to the application. Exchange the
        // same browser-held Google token directly; Firebase still authenticates
        // the identity and owns both the UID and new-account determination.
        const grant = await requestGoogleSignupToken({
          includeContacts: options?.purpose === "initial_contacts" && options.includeContacts !== false,
          signal: options?.signal,
        });
        const requireActiveAttempt = () => {
          if (options?.signal?.aborted) {
            throw new DOMException("Google sign-in was cancelled.", "AbortError");
          }
        };
        requireActiveAttempt();
        options?.onCredentialExchange?.();
        requireActiveAttempt();
        const credential = GoogleAuthProvider.credential(null, grant.accessToken);
        const result = await signInWithCredential(auth, credential);
        // This exchange commits Firebase persistence and cannot be cancelled.
        // Preserve its result so legal/onboarding settlement can finish even
        // when the originating screen has gone away in the meantime.
        const idToken = await result.user.getIdToken();
        return {
          user: result.user,
          idToken,
          accessToken: grant.accessToken,
          isNewUser: getAdditionalUserInfo(result)?.isNewUser,
          ...(grant.contactsGranted
            ? { contactsGrant: { accessToken: grant.accessToken, authority: "firebase-signup" as const } }
            : {}),
        };
      }
      const provider = this.createWebProvider("google");
      if (options?.purpose === "initial_contacts" && options.includeContacts !== false) {
        provider.addScope(GOOGLE_CONTACTS_READ_SCOPE);
        provider.setCustomParameters({ prompt: "select_account", include_granted_scopes: "false" });
      }

      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);

      if (!credential) {
        throw new Error("No credential returned from Google Sign-In");
      }

      const idToken = await result.user.getIdToken();
      const accessToken = credential.accessToken || "";

      this.debugLog("✅ [AuthService] Web sign-in complete");

      return {
        user: result.user,
        idToken,
        accessToken,
        isNewUser: getAdditionalUserInfo(result)?.isNewUser,
        ...(options?.purpose === "initial_contacts" && options.includeContacts !== false && accessToken
          ? { contactsGrant: { accessToken, authority: "firebase-signup" as const } }
          : {}),
      };
    } catch (error) {
      if (!this.isExpectedPopupClose(error)) {
        this.debugError("❌ [AuthService] Web sign-in failed", error);
      }
      throw error;
    }
  }

  /** Microsoft personal/company sign-in is available on the web pilot only. */
  static async signInWithMicrosoft(): Promise<AuthResult> {
    if (Capacitor.isNativePlatform()) {
      throw new Error("Microsoft sign-in is currently available in the web app.");
    }
    // Launch synchronously from the click handler so browsers allow the popup.
    const result = await signInWithPopup(auth, this.createWebProvider("microsoft"));
    return { user: result.user, idToken: await result.user.getIdToken() };
  }

  // ==================== Apple Sign-In ====================

  /**
   * Sign in with Apple using the appropriate method for the current platform.
   *
   * iOS: Uses native ASAuthorizationController via HushhAuth plugin
   * Android: Uses Firebase OAuthProvider (web-based OAuth flow)
   * Web: Uses Firebase signInWithPopup with OAuthProvider
   *
   * @returns Firebase User object (consistent on all platforms)
   */
  static async signInWithApple(): Promise<AuthResult> {
    if (Capacitor.isNativePlatform()) {
      return this.nativeAppleSignIn();
    } else {
      return this.webAppleSignIn();
    }
  }

  /**
   * Native iOS/Android Apple Sign-In flow using HushhAuth plugin
   *
   * iOS: Uses ASAuthorizationController (native Apple Sign-In sheet)
   * Android: Uses Firebase OAuthProvider (web-based OAuth flow)
   *
   * Falls back to web auth if native plugin is not available
   */
  private static async nativeAppleSignIn(): Promise<AuthResult> {
    this.debugLog(
      "🍎 [AuthService] Starting native Apple Sign-In via HushhAuth Plugin",
    );
    const toastId = toast.loading("Signing in with Apple...");

    try {
      const result = await HushhAuth.signInWithApple();

      this.debugLog("✅ [AuthService] Native Apple sign-in returned result");

      if (!result.user || !result.idToken) {
        this.debugError(
          "❌ [AuthService] Invalid response from native Apple sign-in",
        );
        toast.error("Invalid native auth response", { id: toastId });
        throw new Error("Invalid response from native Apple sign-in");
      }

      const idToken = result.idToken;
      const nativeAuthUser = result.user;
      const nativeUid = this.getNativeUserField(
        nativeAuthUser as unknown as Record<string, unknown>,
        ["uid", "id"],
      );

      this.debugLog("✅ [AuthService] Got Apple ID token");

      // Sync with Firebase JS SDK if needed
      // The native plugin already signed in to Firebase on the native layer.
      let firebaseUser = auth.currentUser;

      if (!firebaseUser) {
        this.debugLog(
          "🔄 [AuthService] Syncing Apple credential with Firebase JS SDK...",
        );

        try {
          // The native plugin already handled Firebase sign-in
          // We just need to wait for the JS SDK to catch up
          // For most cases, the native plugin has already signed in successfully
          const syncPromise = new Promise<any>((resolve) => {
            const unsubscribe = auth.onAuthStateChanged((user) => {
              if (user) {
                unsubscribe();
                resolve({ user });
              }
            });
            // If user doesn't appear in 3 seconds, resolve anyway
            setTimeout(() => {
              unsubscribe();
              resolve({ user: null });
            }, 3000);
          });

          const firebaseResult = await syncPromise;
          firebaseUser = firebaseResult.user;

          this.debugLog("✅ [AuthService] Firebase JS SDK synced");
        } catch (syncError) {
          this.debugError(
            "⚠️ [AuthService] JS SDK Sync Failed/Timed Out",
            syncError,
          );
          // Don't show error toast - native auth succeeded, JS sync is optional
          this.debugLog("⚠️ Proceeding with Native User anyway.");
        }
      }

      // A stale Firebase JS session can survive while the native Apple sheet
      // establishes a new account. It must not be paired with the new native
      // token; use the native wrapper until JS reports the matching UID.
      const matchingFirebaseUser =
        firebaseUser && nativeUid && firebaseUser.uid === nativeUid
          ? firebaseUser
          : null;
      if (firebaseUser && !matchingFirebaseUser) {
        this.debugLog(
          "🍎 [AuthService] Ignoring stale Firebase JS user after native Apple sign-in",
        );
      }

      // Construct final User object.
      const user =
        matchingFirebaseUser ||
        this.createUserFromNativeApple(nativeAuthUser, idToken);

      toast.success("Signed in successfully", { id: toastId });

      return {
        user,
        idToken,
        accessToken: result.accessToken,
        isNewUser: result.isNewUser,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.debugError("❌ [AuthService] nativeAppleSignIn error", error);

      // Check for user cancellation
      if (
        errorMessage.includes("USER_CANCELLED") ||
        errorMessage.includes("cancelled") ||
        errorMessage.includes("canceled")
      ) {
        toast.dismiss(toastId);
        throw new Error("Sign in cancelled");
      }

      // If native plugin not implemented, fall back to web auth
      if (
        errorMessage.includes("not implemented") ||
        errorMessage.includes("not available")
      ) {
        this.debugLog(
          "⚠️ [AuthService] Native Apple plugin not available, falling back to web auth",
        );
        toast.dismiss(toastId);
        return this.webAppleSignIn();
      }

      toast.error("Sign in failed: " + errorMessage, { id: toastId });
      throw error;
    }
  }

  /**
   * Create a User-like object from native Apple Sign-In user information
   */
  private static createUserFromNativeApple(
    nativeUser: any,
    idToken: string,
  ): User {
    return this.createUserFromNative(nativeUser, idToken, "apple.com");
  }

  /**
   * Web Apple Sign-In flow
   * Uses Firebase signInWithPopup with OAuthProvider
   * This is ALSO the fallback for native if the native plugin fails
   */
  private static async webAppleSignIn(): Promise<AuthResult> {
    this.debugLog(
      "🌐 [AuthService] Starting web Apple Sign-In (Firebase popup)",
    );

    try {
      const provider = this.createWebProvider("apple");

      const result = await signInWithPopup(auth, provider);
      const idToken = await result.user.getIdToken();

      this.debugLog("✅ [AuthService] Apple web sign-in complete");

      return {
        user: result.user,
        idToken,
        isNewUser: getAdditionalUserInfo(result)?.isNewUser,
      };
    } catch (error) {
      if (!this.isExpectedPopupClose(error)) {
        this.debugError("❌ [AuthService] Apple web sign-in failed", error);
      }
      throw error;
    }
  }

  /**
   * Sign out from all platforms
   * Uses @capacitor-firebase/authentication for uniform behavior
   */
  static async signOut(departingUserId?: string | null): Promise<void> {
    this.debugLog("🚪 [AuthService] Signing out...");
    // Start local preview removal alongside both auth stores. There is no await
    // between the caller's ownership fence and starting credential teardown.
    // Local notification state is keyed by the application owner.
    const notificationOwner =
      departingUserId ?? snapshotValidatedAuthSessionOwner()?.userId ??
      lastAdmittedOwnerFor(auth.currentUser?.uid) ?? auth.currentUser?.uid;
    const localNotificationCleanup = import("@/lib/notifications/fcm-service")
      .then(({ clearLocalChatNotificationState }) => clearLocalChatNotificationState(notificationOwner));

    // Native and Firebase JS auth are independent persistence owners in a
    // Capacitor WebView. Always attempt both; a failure in one must never
    // short-circuit cleanup of the other.
    const results = await Promise.allSettled([
      HushhAuth.signOut(),
      firebaseSignOut(auth),
      (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([localNotificationCleanup, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]); }
        finally { clearTimeout(timer); }
      })(),
    ]);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      const error = new AggregateError(
        failures.map((failure) => failure.reason),
        "One or more authentication stores failed to sign out",
      );
      this.debugError("❌ [AuthService] Sign-out error", error);
      throw error;
    }

    this.debugLog("✅ [AuthService] Sign-out complete");
  }

  static async startPhoneLinkVerification(
    phoneNumber: string,
    options?: {
      recaptchaVerifier?: ApplicationVerifier;
      resendCode?: boolean;
      timeout?: number;
      signal?: AbortSignal;
      allowLinkedPhoneProof?: boolean;
    },
  ): Promise<PhoneVerificationStartResult> {
    return this.startPhoneVerification("link", phoneNumber, options);
  }

  /** Proof verification stays isolated from the primary Firebase session. */
  static startPhoneDeletionVerification(phone: string, verifier: ApplicationVerifier | undefined, context: PhoneDeletionContext) {
    return startDeletionPhoneProof(phone, verifier, context, (error) => this.normalizePhoneVerificationError(error, "link_start"));
  }
  static confirmPhoneDeletionVerification(params: PhoneDeletionConfirmation) {
    return confirmDeletionPhoneProof(params, (error) => this.normalizePhoneVerificationError(error, "link_confirm"));
  }
  static cancelPhoneDeletionVerification = cancelDeletionPhoneProof;

  static async startPhoneReplacementVerification(
    phoneNumber: string,
    options?: {
      recaptchaVerifier?: ApplicationVerifier;
      resendCode?: boolean;
      timeout?: number;
      signal?: AbortSignal;
      allowLinkedPhoneProof?: boolean;
    },
  ): Promise<PhoneVerificationStartResult> {
    return this.startPhoneVerification("replace", phoneNumber, options);
  }

  private static async startPhoneVerification(
    intent: PhoneVerificationIntent,
    phoneNumber: string,
    options?: {
      recaptchaVerifier?: ApplicationVerifier;
      resendCode?: boolean;
      timeout?: number;
      signal?: AbortSignal;
      allowLinkedPhoneProof?: boolean;
    },
  ): Promise<PhoneVerificationStartResult> {
    const normalizedPhoneNumber = String(phoneNumber ?? "").trim();
    if (!normalizedPhoneNumber) {
      throw new Error("Phone number is required.");
    }

    const currentPhoneNumber = String(
      auth.currentUser?.phoneNumber ?? "",
    ).trim();
    const allowLinkedPhoneProof =
      options?.allowLinkedPhoneProof === true &&
      getPhoneReliabilityFlags().recovery;
    if (
      currentPhoneNumber &&
      currentPhoneNumber === normalizedPhoneNumber &&
      !allowLinkedPhoneProof
    ) {
      throw this.createPhoneVerificationError(
        "phone-already-linked-to-current-user",
        "This phone number is already linked to your account.",
      );
    }

    if (
      intent === "link" &&
      currentPhoneNumber &&
      currentPhoneNumber !== normalizedPhoneNumber
    ) {
      throw this.createPhoneVerificationError(
        "phone-replace-required",
        "Use Change phone number to replace the current number.",
      );
    }

    if (Capacitor.isNativePlatform()) {
      try { return await withNativePhoneProofStart(options?.signal, async signal => {
        const current = await this.restoreNativeSession({ nativeOnly: true });
        if (signal.aborted) throw Object.assign(new Error("Your signed-in account changed. Start phone verification again."), { code: "session_changed" });
        if (!current) throw new Error("Sign in before verifying a phone number.");
        return startManualPhoneProof(normalizedPhoneNumber, current.uid, signal, options?.resendCode, options?.signal);
      }); }
      catch (error) { throw this.normalizePhoneVerificationError(error, "link_start"); }
    }

    if (!auth.currentUser) {
      throw new Error(
        intent === "replace"
          ? "You must be signed in before changing the phone number."
          : "You must be signed in before linking a phone number.",
      );
    }

    if (this.shouldUseLocalDevPhoneVerification(normalizedPhoneNumber)) {
      this.debugLog("[AuthService] Using local dev phone verification", {
        intent,
        host: typeof window === "undefined" ? "server" : window.location.host,
      });
      return {
        autoVerified: false,
        verificationId: this.createLocalDevPhoneVerificationId(
          normalizedPhoneNumber,
        ),
      };
    }

    try {
      this.debugLog("[AuthService] Starting phone verification", {
        intent,
        host: typeof window === "undefined" ? "server" : window.location.host,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      });

      const provider = new PhoneAuthProvider(auth);
      const verificationId = await provider.verifyPhoneNumber(
        normalizedPhoneNumber,
        options?.recaptchaVerifier,
      );

      return {
        autoVerified: false,
        verificationId,
      };
    } catch (error) {
      throw this.normalizePhoneVerificationError(
        error,
        intent === "replace" ? "replace_start" : "link_start",
      );
    }
  }

  static async confirmPhoneLinkVerification(params: {
    verificationCode: string;
    confirmationResult?: ConfirmationResult | null;
    verificationId?: string | null;
  }): Promise<User> {
    return this.confirmPhoneVerification("link", params);
  }

  static getPhoneClaimIdToken(params: PhoneClaimConfirmation): Promise<string> {
    return mintPhoneClaimIdToken(params, (error) => this.normalizePhoneVerificationError(error, "link_confirm"));
  }

  static isManualPhoneProof = isManualPhoneProof;

  static async confirmPhoneReplacementVerification(params: {
    verificationCode: string;
    confirmationResult?: ConfirmationResult | null;
    verificationId?: string | null;
  }): Promise<User> {
    return this.confirmPhoneVerification("replace", params);
  }

  private static async confirmPhoneVerification(
    intent: PhoneVerificationIntent,
    params: {
      verificationCode: string;
      confirmationResult?: ConfirmationResult | null;
      verificationId?: string | null;
    },
  ): Promise<User> {
    const verificationCode = String(params.verificationCode ?? "").trim();
    if (!verificationCode) {
      throw new Error("Verification code is required.");
    }

    if (Capacitor.isNativePlatform()) {
      const verificationId = String(params.verificationId ?? "").trim();
      if (!verificationId) {
        throw new Error("Verification ID is required.");
      }

      try {
        await FirebaseAuthentication.confirmVerificationCode({
          verificationId,
          verificationCode,
        });
      } catch (error) {
        throw this.normalizePhoneVerificationError(
          error,
          intent === "replace" ? "replace_confirm" : "link_confirm",
        );
      }

      const restoredUser = await this.restoreNativeSession();
      if (!restoredUser) {
        throw new Error(
          "Phone verification completed but the native session could not be refreshed.",
        );
      }

      return restoredUser;
    }

    try {
      if (!auth.currentUser) {
        throw new Error(
          intent === "replace"
            ? "You must be signed in before changing the phone number."
            : "You must be signed in before linking a phone number.",
        );
      }

      const verificationId = String(params.verificationId ?? "").trim();
      if (!verificationId) {
        throw new Error("Verification ID is required.");
      }

      const credential = PhoneAuthProvider.credential(
        verificationId,
        verificationCode,
      );

      if (intent === "replace") {
        await updatePhoneNumber(auth.currentUser, credential);
        await auth.currentUser.reload().catch(() => undefined);
        return auth.currentUser;
      }

      const linkedCredential = await linkWithCredential(
        auth.currentUser,
        credential,
      );
      await linkedCredential.user.reload().catch(() => undefined);
      return linkedCredential.user;
    } catch (error) {
      throw this.normalizePhoneVerificationError(
        error,
        intent === "replace" ? "replace_confirm" : "link_confirm",
      );
    }
  }

  private static createPhoneVerificationError(
    code: string,
    message: string,
  ): Error {
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    return error;
  }

  private static getPhoneVerificationErrorCode(error: unknown): string {
    const explicitCode =
      typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code?: string }).code)
        : "";
    if (explicitCode) {
      return explicitCode.replace(/^auth\//, "");
    }

    const message = String(
      (error as { message?: unknown })?.message ?? "",
    ).toLowerCase();
    if (message.includes("credential-already-in-use"))
      return "credential-already-in-use";
    if (message.includes("phone-number-already-exists"))
      return "phone-number-already-exists";
    if (message.includes("provider-already-linked"))
      return "provider-already-linked";
    if (message.includes("requires-recent-login"))
      return "requires-recent-login";
    if (message.includes("invalid-app-credential"))
      return "invalid-app-credential";
    if (message.includes("captcha-check-failed")) return "captcha-check-failed";
    if (message.includes("too-many-requests")) return "too-many-requests";
    return "";
  }

  private static normalizePhoneVerificationError(
    error: unknown,
    context:
      "link_start" | "link_confirm" | "replace_start" | "replace_confirm",
  ): Error {
    const code = this.getPhoneVerificationErrorCode(error);

    if (code === "phone-verification-required" || code === "session-expired")
      return this.createPhoneVerificationError("phone-verification-required", "This device no longer has the verification session. Request a new code.");
    if (code === "network-request-failed")
      return this.createPhoneVerificationError(code, "Phone verification is temporarily unavailable. Check your connection and retry.");
    if (code === "phone_manual_sms_required")
      return this.createPhoneVerificationError(code, "A fresh manually entered SMS code is required. Request another code.");
    if (code === "session_changed")
      return this.createPhoneVerificationError(code, "Your signed-in account changed. Start phone verification again.");
    if (code === "phone-verification-start-timeout")
      return this.createPhoneVerificationError(code, "Sending the verification code took too long. Request a new code.");

    if (code === "phone-already-linked-to-current-user") {
      return this.createPhoneVerificationError(
        code,
        "This phone number is already linked to your account.",
      );
    }

    if (code === "phone-replace-required") {
      return this.createPhoneVerificationError(
        code,
        "Use Change phone number to replace the current number.",
      );
    }

    if (code === "code-expired") {
      return this.createPhoneVerificationError(
        code,
        "This verification code has expired. Please request a new code.",
      );
    }

    if (code === "invalid-verification-code") {
      return this.createPhoneVerificationError(
        code,
        "That verification code is incorrect. Please check the code and try again.",
      );
    }

    if (
      code === "credential-already-in-use" ||
      code === "phone-number-already-exists"
    ) {
      // Same words as the mail this triggers, from one shared source. Reading
      // one thing on screen and a different one in the inbox reads like two
      // separate problems.
      return this.createPhoneVerificationError(code, PHONE_CONFLICT_COPY.inApp);
    }

    if (code === "provider-already-linked") {
      return this.createPhoneVerificationError(
        code,
        context.startsWith("replace")
          ? "This account already has a phone number linked. Use Change phone number to replace it."
          : "This account already has a phone number linked.",
      );
    }

    if (code === "requires-recent-login") {
      return this.createPhoneVerificationError(
        code,
        "For security, sign in again before changing your phone number.",
      );
    }

    if (code === "too-many-requests") {
      return this.createPhoneVerificationError(
        code,
        "Firebase is temporarily blocking SMS verification for this phone number or device after too many attempts. Wait before trying again, or use a different phone number.",
      );
    }

    if (code === "invalid-app-credential" || code === "captcha-check-failed") {
      const hostname =
        typeof window === "undefined" ? "" : window.location.hostname;
      const host = typeof window === "undefined" ? "" : window.location.host;
      const origin =
        typeof window === "undefined"
          ? process.env.NEXT_PUBLIC_APP_URL || ""
          : window.location.origin;
      return this.createPhoneVerificationError(
        code,
        host
          ? `Firebase could not verify phone auth from ${host}. Check Firebase Authentication authorized domains, reCAPTCHA settings, and API key restrictions for ${origin || hostname}.`
          : "Firebase could not verify this app for phone auth. Check Firebase Authentication authorized domains and reCAPTCHA configuration.",
      );
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(
      context.startsWith("replace")
        ? "Failed to change the phone number."
        : "Failed to verify the phone number.",
    );
  }

  /**
   * Get current signed-in user
   */
  static getCurrentUser(): User | null {
    return auth.currentUser;
  }

  /**
   * Check if user is signed in
   * Uses @capacitor-firebase/authentication for uniform behavior
   */
  static async isSignedIn(): Promise<boolean> {
    // Check Firebase JS SDK first
    if (auth.currentUser) {
      return true;
    }

    // Use Capacitor Firebase plugin (works on all platforms)
    try {
      const result = await FirebaseAuthentication.getCurrentUser();
      return result.user !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get current user info (platform-aware)
   * Uses @capacitor-firebase/authentication for uniform behavior
   */
  static async getNativeUser(): Promise<AuthUser | null> {
    // Use Capacitor Firebase plugin (works on all platforms)
    try {
      const result = await FirebaseAuthentication.getCurrentUser();
      if (result.user) {
        return {
          id: result.user.uid,
          email: result.user.email || "",
          displayName: result.user.displayName || "",
          photoUrl: result.user.photoUrl || "",
          emailVerified: result.user.emailVerified ?? true,
        };
      }
    } catch {
      // Fall through to Firebase JS SDK
    }

    // Fallback to Firebase JS SDK
    const firebaseUser = auth.currentUser;
    if (firebaseUser) {
      return {
        id: firebaseUser.uid,
        email: firebaseUser.email || "",
        displayName: firebaseUser.displayName || "",
        photoUrl: firebaseUser.photoURL || "",
        emailVerified: firebaseUser.emailVerified,
      };
    }

    return null;
  }

  /**
   * Get ID token (for API calls)
   */
  static async getIdToken(forceRefresh = false): Promise<string | null> {
    let forcedRefreshError: unknown = null;
    // Firebase token takes precedence (it's refreshed automatically)
    const firebaseUser = auth.currentUser;
    if (firebaseUser) {
      try {
        // BOUNDED. `getIdToken` returns the cached token instantly while it is
        // valid; once it has expired -- a person coming back to an open tab after
        // an hour away -- the SDK refreshes it over the network, and that call has
        // no timeout of its own. Seen 2026-09-02 on localhost: the refresh stalled,
        // every `apiFetch` in the tab waited on it BEFORE any request left the
        // browser, and the cloud step read "Checking your cloud..." indefinitely
        // with nothing in the proxy log and nothing on the backend. A stalled
        // refresh must resolve to "no token" so the caller reaches its own error
        // path (a 401, a retry, a bounded screen) instead of hanging forever.
        return await withIdTokenTimeout(firebaseUser.getIdToken(forceRefresh));
      } catch (error) {
        if (forceRefresh && authSessionInvalidationCodeFromFirebaseError(error) !== null) {
          throw error;
        }
        if (forceRefresh) forcedRefreshError = error;
        this.debugError(
          error instanceof IdTokenTimeoutError
            ? "[AuthService] Firebase ID token refresh timed out"
            : "[AuthService] Failed to get Firebase ID token",
        );
      }
    }

    // Browser auth is owned exclusively by the Firebase JS SDK. Calling the
    // Capacitor plugin's web shim here turns a normal signed-out state into a
    // noisy runtime error and cannot recover a browser session.
    if (!Capacitor.isNativePlatform()) {
      if (forceRefresh && forcedRefreshError) throw forcedRefreshError;
      return null;
    }

    const nativeTokenOptions = forceRefresh
      ? { forceRefresh: true }
      : undefined;

    // Prefer the shared Capacitor Firebase plugin when it owns the native
    // session. On iOS, Apple/Google sign-in may instead be restored by the
    // app-owned HushhAuth keychain plugin, so a FirebaseAuthentication runtime
    // error is not evidence that the authenticated session has no token.
    try {
      const result = await FirebaseAuthentication.getIdToken(nativeTokenOptions);
      if (result.token) return result.token;
    } catch (error) {
      if (
        forceRefresh &&
        authSessionInvalidationCodeFromFirebaseError(error) !== null
      ) {
        throw error;
      }
      if (forceRefresh) forcedRefreshError = error;
      this.debugError(
        "[AuthService] FirebaseAuthentication token lookup failed",
        error,
      );
    }

    try {
      const result = await HushhAuth.getIdToken(nativeTokenOptions);
      if (result.idToken) return result.idToken;
    } catch (error) {
      if (
        forceRefresh &&
        authSessionInvalidationCodeFromFirebaseError(error) !== null
      ) {
        throw error;
      }
      if (forceRefresh) forcedRefreshError = error;
      this.debugError("[AuthService] HushhAuth token lookup failed", error);
    }

    if (forceRefresh && forcedRefreshError) throw forcedRefreshError;

    return null;
  }

  /**
   * Subscribe to auth state changes
   */
  /**
   * Restores the session using @capacitor-firebase/authentication
   * Works on all platforms for uniform behavior
   */
  static async restoreNativeSession(options?: { nativeOnly?: boolean }): Promise<User | null> {
    const waitForFirebaseJsUser = async (): Promise<User | null> =>
      new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        let timeout: ReturnType<typeof setTimeout>;
        const finish = (user: User | null) => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          clearTimeout(timeout);
          resolve(user);
        };
        timeout = setTimeout(() => finish(auth.currentUser), 1_000);
        const unsubscribeCandidate = onAuthStateChanged(auth, finish, () =>
          finish(null),
        );
        if (typeof unsubscribeCandidate === "function") {
          if (settled) {
            unsubscribeCandidate();
          } else {
            unsubscribe = unsubscribeCandidate;
          }
        }
      });

    const restoreFromFirebaseAuthentication =
      async (): Promise<User | null> => {
        const result = await FirebaseAuthentication.getCurrentUser();
        if (!result.user) {
          return null;
        }

        const restoredUserId = this.getNativeUserField(
          result.user as unknown as Record<string, unknown>,
          ["uid", "id"],
        );
        let tokenResult: Awaited<
          ReturnType<typeof FirebaseAuthentication.getIdToken>
        >;
        try {
          tokenResult = await FirebaseAuthentication.getIdToken();
        } catch (error) {
          if (authSessionInvalidationCodeFromFirebaseError(error)) {
            throw this.nativeRestoreTerminalError(error, restoredUserId);
          }
          throw error;
        }
        const idToken = tokenResult.token || "";
        const providerId =
          result.user.providerData?.find(
            (provider) => provider.providerId && provider.providerId !== "firebase",
          )?.providerId?.trim() ||
          (result.user as { providerId?: string | null }).providerId?.trim() ||
          auth.currentUser?.providerData?.[0]?.providerId ||
          "native";

        return this.createUserFromNative(result.user, idToken, providerId);
      };

    const restoreFromHushhAuth = async (): Promise<User | null> => {
      const { user } = await HushhAuth.getCurrentUser();
      if (!user) {
        return null;
      }
      const restoredUserId = this.getNativeUserField(
        user as unknown as Record<string, unknown>,
        ["uid", "id"],
      );
      let idToken: string | null | undefined;
      try {
        ({ idToken } = await HushhAuth.getIdToken());
      } catch (error) {
        if (authSessionInvalidationCodeFromFirebaseError(error)) {
          throw this.nativeRestoreTerminalError(error, restoredUserId);
        }
        throw error;
      }
      const restoredIdToken = this.isUsableIdToken(idToken)
        ? String(idToken)
        : "";
      if (!restoredIdToken) {
        return null;
      }

      const providerId =
        (user as { providerId?: string | null }).providerId?.trim() || "native";

      return this.createUserFromNative(user, restoredIdToken, providerId);
    };

    try {
      if (!options?.nativeOnly && auth.currentUser) {
        this.debugLog(
          "✅ [AuthService] Firebase JS SDK user already available",
        );
        return auth.currentUser;
      }

      const firebaseJsUser = options?.nativeOnly ? null : await waitForFirebaseJsUser();
      if (firebaseJsUser) {
        this.debugLog(
          "✅ [AuthService] Firebase JS SDK user restored from persistence",
        );
        return firebaseJsUser;
      }

      const maxAttempts = Capacitor.getPlatform() === "ios" ? 4 : 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        this.debugLog(
          `🍎 [AuthService] Attempting native session restore (${attempt}/${maxAttempts})`,
        );

        const restoredUser =
          (await restoreFromFirebaseAuthentication().catch((error) => {
            if (authSessionInvalidationCodeFromFirebaseError(error)) {
              throw error;
            }
            this.debugError(
              "🍎 [AuthService] FirebaseAuthentication restore failed",
              error,
            );
            return null;
          })) ||
          (await restoreFromHushhAuth().catch((error) => {
            if (authSessionInvalidationCodeFromFirebaseError(error)) {
              throw error;
            }
            this.debugError("🍎 [AuthService] HushhAuth restore failed", error);
            return null;
          }));

        if (restoredUser) {
          this.debugLog("🍎 [AuthService] Session restored");
          return restoredUser;
        }

        if (attempt < maxAttempts) {
          await this.pause(attempt === 1 ? 200 : 400);
        }
      }

      this.debugLog("🍎 [AuthService] No session found");
      return null;
    } catch (error) {
      this.debugError("🍎 [AuthService] Failed to restore session", error);
      if (authSessionInvalidationCodeFromFirebaseError(error)) {
        throw error;
      }
      return null;
    }
  }

  static onAuthStateChanged(callback: (user: User | null) => void): () => void {
    return onAuthStateChanged(auth, callback);
  }
}
