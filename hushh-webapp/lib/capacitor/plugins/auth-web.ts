/**
 * Hussh Auth - Web Implementation
 * 
 * Web fallback for HushhAuthPlugin that uses Firebase signInWithPopup.
 * This is used on web browsers where native authentication is not available.
 * 
 * Supports:
 * - Google Sign-In via GoogleAuthProvider
 * - Apple Sign-In via OAuthProvider('apple.com')
 */

import type { HushhAuthPlugin, AuthUser } from "../index";
import { GoogleAuthProvider, OAuthProvider, signInWithPopup, signOut, User } from "firebase/auth";
import { auth } from "@/lib/firebase/config";

export class HushhAuthWeb implements HushhAuthPlugin {
  private currentUser: AuthUser | null = null;
  private currentIdToken: string | null = null;
  private currentAccessToken: string | null = null;

  async signIn(): Promise<{
    idToken: string;
    accessToken: string;
    user: AuthUser;
  }> {
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
      
      const user: AuthUser = {
        id: result.user.uid,
        email: result.user.email || "",
        displayName: result.user.displayName || "",
        photoUrl: result.user.photoURL || "",
        emailVerified: result.user.emailVerified,
      };
      
      this.currentUser = user;
      this.currentIdToken = idToken;
      this.currentAccessToken = accessToken;
      
      console.log("✅ [HushhAuthWeb] Google Sign-in successful:", user.email);
      
      return { idToken, accessToken, user };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Sign-in failed";
      console.error("❌ [HushhAuthWeb] Google Sign-in error:", message);
      throw error;
    }
  }

  async signInWithApple(): Promise<{
    idToken: string;
    accessToken?: string;
    rawNonce?: string;
    user: AuthUser;
  }> {
    try {
      const provider = new OAuthProvider('apple.com');
      provider.addScope('email');
      provider.addScope('name');
      
      const result = await signInWithPopup(auth, provider);
      const idToken = await result.user.getIdToken();
      
      // Apple may return null email if user chose to hide it (relay address)
      const user: AuthUser = {
        id: result.user.uid,
        email: result.user.email || "",
        displayName: result.user.displayName || "",
        photoUrl: result.user.photoURL || "",
        emailVerified: result.user.emailVerified,
      };
      
      this.currentUser = user;
      this.currentIdToken = idToken;
      
      console.log("✅ [HushhAuthWeb] Apple Sign-in successful:", user.email || "(hidden email)");
      
      return { idToken, user };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Apple Sign-in failed";
      console.error("❌ [HushhAuthWeb] Apple Sign-in error:", message);
      throw error;
    }
  }

  async signOut(): Promise<void> {
    try {
      await signOut(auth);
      this.currentUser = null;
      this.currentIdToken = null;
      this.currentAccessToken = null;
      console.log("✅ [HushhAuthWeb] Signed out");
    } catch (error) {
      console.error("❌ [HushhAuthWeb] Sign-out error:", error);
      throw error;
    }
  }

  async getIdToken(): Promise<{ idToken: string | null }> {
    // Try to get fresh token from current Firebase user
    const firebaseUser = auth.currentUser;
    if (firebaseUser) {
      try {
        const token = await firebaseUser.getIdToken();
        this.currentIdToken = token;
        return { idToken: token };
      } catch {
        console.warn("[HushhAuthWeb] Failed to get fresh token");
      }
    }
    
    return { idToken: this.currentIdToken };
  }

  async getCurrentUser(): Promise<{ user: AuthUser | null }> {
    // Check Firebase auth first
    const firebaseUser = auth.currentUser;
    if (firebaseUser) {
      this.currentUser = this.mapFirebaseUser(firebaseUser);
      return { user: this.currentUser };
    }
    
    return { user: this.currentUser };
  }

  async isSignedIn(): Promise<{ signedIn: boolean }> {
    const firebaseUser = auth.currentUser;
    return { signedIn: !!firebaseUser || !!this.currentIdToken };
  }

  private mapFirebaseUser(user: User): AuthUser {
    return {
      id: user.uid,
      email: user.email || "",
      displayName: user.displayName || "",
      photoUrl: user.photoURL || "",
      emailVerified: user.emailVerified,
    };
  }
}
