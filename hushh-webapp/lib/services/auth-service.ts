/**
 * Auth Service - Platform-Aware Authentication
 *
 * Production-grade authentication service that handles:
 * - iOS: Native Google Sign-In and Sign in with Apple via HushhAuth plugin
 * - Android: Native Google Sign-In and Firebase OAuthProvider for Apple
 * - Web: Firebase signInWithPopup for both providers
 * - Credential sync: Native tokens synced with Firebase for consistent UIDs
 *
 * IMPORTANT: This is the single source of truth for authentication.
 * Components should use this service instead of direct Firebase calls.
 */

import { Capacitor } from "@capacitor/core";
import {
  type ApplicationVerifier,
  type ConfirmationResult,
  GoogleAuthProvider,
  OAuthProvider,
  PhoneAuthProvider,
  linkWithCredential,
  signInWithCredential,
  signInWithCustomToken as firebaseSignInWithCustomToken,
  signInWithPopup,
  signOut as firebaseSignOut,
  updatePhoneNumber,
  User,
  onAuthStateChanged,
} from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import { FirebaseAuthentication, ProviderId } from "@capacitor-firebase/authentication";
import { HushhAuth, type AuthUser } from "@/lib/capacitor";
import { toast } from "sonner";

export interface AuthResult {
  user: User;
  idToken: string;
  accessToken?: string;
}

export interface PhoneVerificationStartResult {
  autoVerified: boolean;
  confirmationResult?: ConfirmationResult;
  verificationId?: string;
  user?: User | null;
}

type PhoneVerificationIntent = "link" | "replace";

/**
 * Platform-aware authentication service
 */
export class AuthService {
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

  private static decodeJwtPayload(token: string): Record<string, unknown> | null {
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

  private static isUsableIdToken(token: string | null | undefined, minRemainingMs = 60_000): boolean {
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
    forceRefresh = false
  ): Promise<string> {
    const firebaseUser = auth.currentUser;
    if (firebaseUser) {
      try {
        return await firebaseUser.getIdToken(forceRefresh);
      } catch (error) {
        this.debugError("[AuthService] Failed to get Firebase JS token during native resolution", error);
      }
    }

    try {
      const result = await FirebaseAuthentication.getIdToken();
      if (result.token && this.isUsableIdToken(result.token)) {
        return result.token;
      }
    } catch (error) {
      this.debugError("[AuthService] FirebaseAuthentication token lookup failed", error);
    }

    try {
      const result = await HushhAuth.getIdToken();
      if (result.idToken && this.isUsableIdToken(result.idToken)) {
        return result.idToken;
      }
    } catch (error) {
      this.debugError("[AuthService] HushhAuth token lookup failed", error);
    }

    return this.isUsableIdToken(initialToken) ? initialToken : "";
  }

  /**
   * Sign in with Google using the appropriate method for the current platform.
   *
   * iOS: Uses @capacitor-firebase/authentication plugin
   * Web: Uses Firebase signInWithPopup directly
   *
   * @returns Firebase User object (consistent on both platforms)
   */
  static async signInWithGoogle(): Promise<AuthResult> {
    if (Capacitor.isNativePlatform()) {
      return this.nativeGoogleSignIn();
    } else {
      return this.webGoogleSignIn();
    }
  }

  /**
   * Sign in with Email and Password using appropriate method for platform.
   * On Native: Uses @capacitor-firebase/authentication for Keychain persistence.
   * On Web: Uses Firebase JS SDK directly.
   */
  static async signInWithEmailAndPassword(email: string, password: string): Promise<AuthResult> {
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
           await new Promise(resolve => setTimeout(resolve, 500));
           firebaseUser = auth.currentUser;
        }

        const user = firebaseUser || this.createUserFromNative(result.user, idToken, "password");
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
      const { signInWithEmailAndPassword: webSignIn } = await import("firebase/auth");
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
  static async signInWithCustomToken(customToken: string): Promise<AuthResult> {
    const result = await firebaseSignInWithCustomToken(auth, customToken);
    const idToken = await result.user.getIdToken();
    return {
      user: result.user,
      idToken,
    };
  }

  /**
   * Native iOS/Android Google Sign-In flow using @capacitor-firebase/authentication
   * 1. FirebaseAuthentication.signInWithGoogle() presents native Google UI
   * 2. Automatically syncs with Firebase
   * 3. Returns authenticated user
   *
   * Falls back to web auth if native plugin is not available
   */
  private static async nativeGoogleSignIn(): Promise<AuthResult> {
    this.debugLog(
      "🍎 [AuthService] Starting native Google Sign-In via FirebaseAuthentication"
    );
    const toastId = toast.loading("Signing in with Google...");

    try {
      this.debugLog("🍎 [AuthService] Calling FirebaseAuthentication.signInWithGoogle()...");

      const result = await FirebaseAuthentication.signInWithGoogle();

      this.debugLog("✅ [AuthService] Native sign-in returned result");

      if (!result.user) {
        this.debugError("❌ [AuthService] Invalid response from native sign-in");
        toast.error("Invalid native auth response", { id: toastId });
        throw new Error("Invalid response from native sign-in");
      }

      const nativeIdTokenResult = await FirebaseAuthentication.getIdToken();
      const idToken =
        nativeIdTokenResult.token ||
        result.credential?.idToken ||
        "";
      const accessToken = result.credential?.accessToken;
      const nativeAuthUser = result.user; // AuthUser type

      this.debugLog("✅ [AuthService] Got native ID token");

      // Step 3: Sync with Firebase JS SDK if needed
      // The native plugin already signed in to Firebase on the native layer.
      // We usually want the JS layer to also know about it for consistency.
      let firebaseUser = auth.currentUser;

      if (!firebaseUser) {
        this.debugLog("🔄 [AuthService] Syncing with Firebase JS SDK...");

        // We need a credential to sign in the JS SDK.
        // We have the Google ID Token and Access Token from the native result.
        if (!idToken || !accessToken) {
          throw new Error("Missing Google credential tokens for JS SDK sync");
        }

        const credential = GoogleAuthProvider.credential(idToken, accessToken);

        try {
          // Wrapped in a timeout to prevent hanging on iOS
          const syncPromise = signInWithCredential(auth, credential);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("JS SDK Sync Timed Out")), 5000)
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
            syncError
          );
          // Don't show error toast to user as this is a background sync issue
          // toast.error("JS SDK Sync Failed (proceeding with native user)");
          this.debugLog("⚠️ Proceeding with Native User anyway.");
        }
      }

      // Construct final User object
      // If JS SDK failed, we wrap the native user data into a Firebase-like User object
      const user =
        firebaseUser || this.createUserFromNative(nativeAuthUser, idToken);

      toast.success("Signed in successfully", { id: toastId });

      return {
        user,
        idToken,
        accessToken,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.debugError("❌ [AuthService] nativeGoogleSignIn error");

      // If native plugin not implemented, fall back to web auth
      if (
        errorMessage.includes("not implemented") ||
        errorMessage.includes("not available")
      ) {
        this.debugLog(
          "⚠️ [AuthService] Native plugin not available, falling back to web auth"
        );
        toast.dismiss(toastId); // Dismiss loading before switching
        return this.webGoogleSignIn();
      }

      toast.error("Sign in failed: " + errorMessage, { id: toastId });
      this.debugError("❌ [AuthService] Native sign-in failed", error);
      throw error;
    }
  }

  /**
   * Create a User-like object from native Firebase user data
   */
  private static createUserFromNative(
    nativeUser: any,
    idToken: string,
    providerId: string = "google.com"
  ): User {
    const uid = this.getNativeUserField(nativeUser, ["uid", "id"]);
    const email = this.getNativeUserField(nativeUser, ["email"]);
    const displayName = this.getNativeUserField(nativeUser, ["displayName"]);
    const photoURL = this.getNativeUserField(nativeUser, ["photoUrl", "photoURL"]);
    const phoneNumber = this.getNativeUserField(nativeUser, ["phoneNumber"]);
    const emailVerified =
      typeof nativeUser?.emailVerified === "boolean"
        ? nativeUser.emailVerified
        : true;
    const liveTokenProvider = async (forceRefresh = false) =>
      this.resolveLiveNativeIdToken(idToken, forceRefresh);

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
        return {
          token: liveToken,
          claims: {},
          authTime: "",
          issuedAtTime: "",
          expirationTime: "",
          signInProvider: providerId,
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
   * Uses Firebase signInWithPopup directly (for web browsers)
   * This is ALSO the fallback for native if the native plugin fails
   */
  private static async webGoogleSignIn(): Promise<AuthResult> {
    this.debugLog(
      "🌐 [AuthService] Starting web Google Sign-In (Firebase popup)"
    );

    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });

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
      };
    } catch (error) {
      this.debugError("❌ [AuthService] Web sign-in failed", error);
      throw error;
    }
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
    this.debugLog("🍎 [AuthService] Starting native Apple Sign-In via HushhAuth Plugin");
    const toastId = toast.loading("Signing in with Apple...");

    try {
      const result = await HushhAuth.signInWithApple();

      this.debugLog("✅ [AuthService] Native Apple sign-in returned result");

      if (!result.user || !result.idToken) {
        this.debugError("❌ [AuthService] Invalid response from native Apple sign-in");
        toast.error("Invalid native auth response", { id: toastId });
        throw new Error("Invalid response from native Apple sign-in");
      }

      const idToken = result.idToken;
      const nativeAuthUser = result.user;

      this.debugLog("✅ [AuthService] Got Apple ID token");

      // Sync with Firebase JS SDK if needed
      // The native plugin already signed in to Firebase on the native layer.
      let firebaseUser = auth.currentUser;

      if (!firebaseUser) {
        this.debugLog("🔄 [AuthService] Syncing Apple credential with Firebase JS SDK...");

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
            syncError
          );
          // Don't show error toast - native auth succeeded, JS sync is optional
          this.debugLog("⚠️ Proceeding with Native User anyway.");
        }
      }

      // Construct final User object
      const user = firebaseUser || this.createUserFromNativeApple(nativeAuthUser, idToken);

      toast.success("Signed in successfully", { id: toastId });

      return {
        user,
        idToken,
        accessToken: result.accessToken,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.debugError("❌ [AuthService] nativeAppleSignIn error", error);

      // Check for user cancellation
      if (errorMessage.includes("USER_CANCELLED") || errorMessage.includes("cancelled") || errorMessage.includes("canceled")) {
        toast.dismiss(toastId);
        throw new Error("Sign in cancelled");
      }

      // If native plugin not implemented, fall back to web auth
      if (
        errorMessage.includes("not implemented") ||
        errorMessage.includes("not available")
      ) {
        this.debugLog(
          "⚠️ [AuthService] Native Apple plugin not available, falling back to web auth"
        );
        toast.dismiss(toastId);
        return this.webAppleSignIn();
      }

      toast.error("Sign in failed: " + errorMessage, { id: toastId });
      throw error;
    }
  }

  /**
   * Create a User-like object from native Apple Sign-In user data
   */
  private static createUserFromNativeApple(nativeUser: any, idToken: string): User {
    return this.createUserFromNative(nativeUser, idToken, "apple.com");
  }

  /**
   * Web Apple Sign-In flow
   * Uses Firebase signInWithPopup with OAuthProvider
   * This is ALSO the fallback for native if the native plugin fails
   */
  private static async webAppleSignIn(): Promise<AuthResult> {
    this.debugLog("🌐 [AuthService] Starting web Apple Sign-In (Firebase popup)");

    try {
      const provider = new OAuthProvider("apple.com");
      provider.addScope("email");
      provider.addScope("name");

      const result = await signInWithPopup(auth, provider);
      const idToken = await result.user.getIdToken();

      this.debugLog("✅ [AuthService] Apple web sign-in complete");

      return {
        user: result.user,
        idToken,
      };
    } catch (error) {
      this.debugError("❌ [AuthService] Apple web sign-in failed", error);
      throw error;
    }
  }

  /**
   * Sign out from all platforms
   * Uses @capacitor-firebase/authentication for uniform behavior
   */
  static async signOut(): Promise<void> {
    this.debugLog("🚪 [AuthService] Signing out...");

    try {
      // Sign out using Custom HushhAuth plugin
      await HushhAuth.signOut();

      // Also sign out from Firebase JS SDK for web consistency
      await firebaseSignOut(auth);

      this.debugLog("✅ [AuthService] Sign-out complete");
    } catch (error) {
      this.debugError("❌ [AuthService] Sign-out error", error);
      toast.error("SignOut Failed: " + error);
      throw error;
    }
  }

  static async startPhoneLinkVerification(
    phoneNumber: string,
    options?: {
      recaptchaVerifier?: ApplicationVerifier;
      resendCode?: boolean;
      timeout?: number;
    }
  ): Promise<PhoneVerificationStartResult> {
    return this.startPhoneVerification("link", phoneNumber, options);
  }

  static async startPhoneReplacementVerification(
    phoneNumber: string,
    options?: {
      recaptchaVerifier?: ApplicationVerifier;
      resendCode?: boolean;
      timeout?: number;
    }
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
    }
  ): Promise<PhoneVerificationStartResult> {
    const normalizedPhoneNumber = String(phoneNumber ?? "").trim();
    if (!normalizedPhoneNumber) {
      throw new Error("Phone number is required.");
    }

    const currentPhoneNumber = String(auth.currentUser?.phoneNumber ?? "").trim();
    if (currentPhoneNumber && currentPhoneNumber === normalizedPhoneNumber) {
      throw this.createPhoneVerificationError(
        "phone-already-linked-to-current-user",
        "This phone number is already linked to your account."
      );
    }

    if (intent === "link" && currentPhoneNumber && currentPhoneNumber !== normalizedPhoneNumber) {
      throw this.createPhoneVerificationError(
        "phone-replace-required",
        "Use Change phone number to replace the current number."
      );
    }

    if (Capacitor.isNativePlatform()) {
      if (!(await this.isSignedIn())) {
        throw new Error(
          intent === "replace"
            ? "You must be signed in before changing the phone number."
            : "You must be signed in before linking a phone number."
        );
      }

      const handles: Array<{ remove: () => Promise<void> }> = [];
      const cleanup = async () => {
        await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)));
      };

      return await new Promise<PhoneVerificationStartResult>((resolve, reject) => {
        let settled = false;

        const settle = async (
          next:
            | { type: "resolve"; value: PhoneVerificationStartResult }
            | { type: "reject"; error: Error }
        ) => {
          if (settled) return;
          settled = true;
          await cleanup();
          if (next.type === "resolve") {
            resolve(next.value);
            return;
          }
          reject(next.error);
        };

        void (async () => {
          try {
            handles.push(
              await FirebaseAuthentication.addListener("phoneCodeSent", async (event) => {
                await settle({
                  type: "resolve",
                  value: {
                    autoVerified: false,
                    verificationId: event.verificationId,
                  },
                });
              })
            );
            handles.push(
              await FirebaseAuthentication.addListener(
                "phoneVerificationFailed",
                async (event) => {
                  await settle({
                    type: "reject",
                    error: new Error(event.message || "Phone verification failed."),
                  });
                }
              )
            );
            handles.push(
              await FirebaseAuthentication.addListener(
                "phoneVerificationCompleted",
                async () => {
                  const restoredUser = await this.restoreNativeSession();
                  await settle({
                    type: "resolve",
                    value: {
                      autoVerified: true,
                      user: restoredUser,
                    },
                  });
                }
              )
            );

            if (intent === "replace" && currentPhoneNumber) {
              await FirebaseAuthentication.unlink({ providerId: ProviderId.PHONE });
            }

            await FirebaseAuthentication.linkWithPhoneNumber({
              phoneNumber: normalizedPhoneNumber,
              resendCode: options?.resendCode,
              timeout: options?.timeout,
            });
          } catch (error) {
            await settle({
              type: "reject",
              error: this.normalizePhoneVerificationError(
                error,
                intent === "replace" ? "replace_start" : "link_start"
              ),
            });
          }
        })();
      });
    }

    if (!auth.currentUser) {
      throw new Error(
        intent === "replace"
          ? "You must be signed in before changing the phone number."
          : "You must be signed in before linking a phone number."
      );
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
        options?.recaptchaVerifier
      );

      return {
        autoVerified: false,
        verificationId,
      };
    } catch (error) {
      throw this.normalizePhoneVerificationError(
        error,
        intent === "replace" ? "replace_start" : "link_start"
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
    }
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
          intent === "replace" ? "replace_confirm" : "link_confirm"
        );
      }

      const restoredUser = await this.restoreNativeSession();
      if (!restoredUser) {
        throw new Error("Phone verification completed but the native session could not be refreshed.");
      }

      return restoredUser;
    }

    try {
      if (!auth.currentUser) {
        throw new Error(
          intent === "replace"
            ? "You must be signed in before changing the phone number."
            : "You must be signed in before linking a phone number."
        );
      }

      const verificationId = String(params.verificationId ?? "").trim();
      if (!verificationId) {
        throw new Error("Verification ID is required.");
      }

      const credential = PhoneAuthProvider.credential(verificationId, verificationCode);

      if (intent === "replace") {
        await updatePhoneNumber(auth.currentUser, credential);
        await auth.currentUser.reload().catch(() => undefined);
        return auth.currentUser;
      }

      const linkedCredential = await linkWithCredential(auth.currentUser, credential);
      await linkedCredential.user.reload().catch(() => undefined);
      return linkedCredential.user;
    } catch (error) {
      throw this.normalizePhoneVerificationError(
        error,
        intent === "replace" ? "replace_confirm" : "link_confirm"
      );
    }
  }

  private static createPhoneVerificationError(code: string, message: string): Error {
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

    const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
    if (message.includes("credential-already-in-use")) return "credential-already-in-use";
    if (message.includes("provider-already-linked")) return "provider-already-linked";
    if (message.includes("requires-recent-login")) return "requires-recent-login";
    if (message.includes("invalid-app-credential")) return "invalid-app-credential";
    if (message.includes("captcha-check-failed")) return "captcha-check-failed";
    if (message.includes("too-many-requests")) return "too-many-requests";
    return "";
  }

  private static normalizePhoneVerificationError(
    error: unknown,
    context: "link_start" | "link_confirm" | "replace_start" | "replace_confirm"
  ): Error {
    const code = this.getPhoneVerificationErrorCode(error);

    if (code === "phone-already-linked-to-current-user") {
      return this.createPhoneVerificationError(
        code,
        "This phone number is already linked to your account."
      );
    }

    if (code === "phone-replace-required") {
      return this.createPhoneVerificationError(
        code,
        "Use Change phone number to replace the current number."
      );
    }

    if (code === "credential-already-in-use") {
      return this.createPhoneVerificationError(
        code,
        "This phone number is already associated with another account."
      );
    }

    if (code === "provider-already-linked") {
      return this.createPhoneVerificationError(
        code,
        context.startsWith("replace")
          ? "This account already has a phone number linked. Use Change phone number to replace it."
          : "This account already has a phone number linked."
      );
    }

    if (code === "requires-recent-login") {
      return this.createPhoneVerificationError(
        code,
        "For security, sign in again before changing your phone number."
      );
    }

    if (code === "too-many-requests") {
      return this.createPhoneVerificationError(
        code,
        "Firebase is temporarily blocking SMS verification for this phone number or device after too many attempts. Wait before trying again, or use a different phone number."
      );
    }

    if (code === "invalid-app-credential" || code === "captcha-check-failed") {
      const hostname = typeof window === "undefined" ? "" : window.location.hostname;
      const host = typeof window === "undefined" ? "" : window.location.host;
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      return this.createPhoneVerificationError(
        code,
        host
          ? `Firebase could not verify phone auth from ${host}. Open ${appUrl} and check that ${hostname} is in Firebase Authentication authorized domains.`
          : "Firebase could not verify this app for phone auth. Check Firebase Authentication authorized domains and reCAPTCHA configuration."
      );
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(
      context.startsWith("replace")
        ? "Failed to change the phone number."
        : "Failed to verify the phone number."
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
    // Firebase token takes precedence (it's refreshed automatically)
    const firebaseUser = auth.currentUser;
    if (firebaseUser) {
      try {
        return await firebaseUser.getIdToken(forceRefresh);
      } catch {
        this.debugError("[AuthService] Failed to get Firebase ID token");
      }
    }

    // Fallback to Capacitor Firebase plugin
    try {
      const result = await FirebaseAuthentication.getIdToken();
      return result.token;
    } catch {
      return null;
    }
  }

  /**
   * Subscribe to auth state changes
   */
  /**
   * Restores the session using @capacitor-firebase/authentication
   * Works on all platforms for uniform behavior
   */
  static async restoreNativeSession(): Promise<User | null> {
    const restoreFromFirebaseAuthentication = async (): Promise<User | null> => {
      const result = await FirebaseAuthentication.getCurrentUser();
      if (!result.user) {
        return null;
      }

      const tokenResult = await FirebaseAuthentication.getIdToken();
      const idToken = tokenResult.token || "";
      const providerId =
        (result.user as { providerId?: string | null }).providerId?.trim() ||
        auth.currentUser?.providerData?.[0]?.providerId ||
        "native";

      return this.createUserFromNative(result.user, idToken, providerId);
    };

    const restoreFromHushhAuth = async (): Promise<User | null> => {
      const [{ user }, { idToken }] = await Promise.all([
        HushhAuth.getCurrentUser(),
        HushhAuth.getIdToken(),
      ]);
      if (!user) {
        return null;
      }
      const restoredIdToken = this.isUsableIdToken(idToken) ? String(idToken) : "";
      if (!restoredIdToken) {
        return null;
      }

      const providerId =
        (user as { providerId?: string | null }).providerId?.trim() || "native";

      return this.createUserFromNative(user, restoredIdToken, providerId);
    };

    try {
      if (auth.currentUser) {
        this.debugLog("✅ [AuthService] Firebase JS SDK user already available");
        return auth.currentUser;
      }

      const maxAttempts = Capacitor.getPlatform() === "ios" ? 4 : 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        this.debugLog(`🍎 [AuthService] Attempting native session restore (${attempt}/${maxAttempts})`);

        const restoredUser =
          (await restoreFromFirebaseAuthentication().catch((error) => {
            this.debugError("🍎 [AuthService] FirebaseAuthentication restore failed", error);
            return null;
          })) ||
          (await restoreFromHushhAuth().catch((error) => {
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
      return null;
    }
  }

  static onAuthStateChanged(callback: (user: User | null) => void): () => void {
    return onAuthStateChanged(auth, callback);
  }
}
