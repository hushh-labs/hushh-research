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
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  signInWithCustomToken as firebaseSignInWithCustomToken,
  signInWithPopup,
  signOut as firebaseSignOut,
  User,
  onAuthStateChanged,
} from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import { HushhAuth, type AuthUser } from "@/lib/capacitor";
import { toast } from "sonner";

export interface AuthResult {
  user: User;
  idToken: string;
  accessToken?: string;
}

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
    return {
      uid: nativeUser.uid,
      email: nativeUser.email,
      displayName: nativeUser.displayName,
      photoURL: nativeUser.photoUrl,
      emailVerified: nativeUser.emailVerified ?? true,
      isAnonymous: false,
      metadata: {
        creationTime: new Date().toISOString(),
        lastSignInTime: new Date().toISOString(),
      },
      providerData: [
        {
          providerId,
          uid: nativeUser.uid,
          displayName: nativeUser.displayName,
          email: nativeUser.email,
          phoneNumber: null,
          photoURL: nativeUser.photoUrl,
        },
      ],
      refreshToken: "",
      tenantId: null,
      delete: async () => {},
      getIdToken: async () => idToken,
      getIdTokenResult: async () => ({
        token: idToken,
        claims: {},
        authTime: "",
        issuedAtTime: "",
        expirationTime: "",
        signInProvider: providerId,
        signInSecondFactor: null,
      }),
      reload: async () => {},
      toJSON: () => ({}),
      phoneNumber: null,
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
    return {
      uid: nativeUser.uid,
      email: nativeUser.email,
      displayName: nativeUser.displayName,
      photoURL: nativeUser.photoUrl,
      emailVerified: nativeUser.emailVerified ?? true,
      isAnonymous: false,
      metadata: {
        creationTime: new Date().toISOString(),
        lastSignInTime: new Date().toISOString(),
      },
      providerData: [
        {
          providerId: "apple.com",
          uid: nativeUser.uid,
          displayName: nativeUser.displayName,
          email: nativeUser.email,
          phoneNumber: null,
          photoURL: nativeUser.photoUrl,
        },
      ],
      refreshToken: "",
      tenantId: null,
      delete: async () => {},
      getIdToken: async () => idToken,
      getIdTokenResult: async () => ({
        token: idToken,
        claims: {},
        authTime: "",
        issuedAtTime: "",
        expirationTime: "",
        signInProvider: "apple.com",
        signInSecondFactor: null,
      }),
      reload: async () => {},
      toJSON: () => ({}),
      phoneNumber: null,
      providerId: "apple.com",
    } as unknown as User;
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
    try {
      // Use Capacitor Firebase plugin to get current user
      const result = await FirebaseAuthentication.getCurrentUser();

      if (!result.user) {
        this.debugLog("🍎 [AuthService] No session found");
        return null;
      }

      this.debugLog("🍎 [AuthService] Restoring session");

      // Get ID token
      const tokenResult = await FirebaseAuthentication.getIdToken();
      const idToken = tokenResult.token || "";

      // Check if Firebase JS SDK has the user
      if (auth.currentUser) {
        this.debugLog("✅ [AuthService] Firebase JS SDK user available");
        return auth.currentUser;
      }

      // Construct User object from native data
      // If the user has an email, assume password provider for restoration if not google/apple
      // Usually getCurrentUser() result.user contains providerId in some plugins, 
      // but @capacitor-firebase/authentication might not expose it clearly in result.user
      // We'll check email presence.
      const providerId = result.user.email ? "password" : "google.com"; 

      const restoredUser = this.createUserFromNative(result.user, idToken, providerId);

      this.debugLog("🍎 [AuthService] Session restored");
      return restoredUser;
    } catch (error) {
      this.debugError("🍎 [AuthService] Failed to restore session", error);
      return null;
    }
  }

  static onAuthStateChanged(callback: (user: User | null) => void): () => void {
    return onAuthStateChanged(auth, callback);
  }
}
