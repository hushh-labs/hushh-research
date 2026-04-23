/**
 * Firebase Configuration
 * ======================
 * 
 * Production-grade Firebase setup for Hussh webapp.
 * Uses Phone Authentication for consent-first user identification.
 */

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, RecaptchaVerifier } from "firebase/auth";
import { resolveAnalyticsMeasurementId } from "@/lib/observability/env";

const firebaseMeasurementId = resolveAnalyticsMeasurementId();

// Primary Firebase configuration (non-auth app behaviors).
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  ...(firebaseMeasurementId ? { measurementId: firebaseMeasurementId } : {}),
};

// Log warning if running with dummy or missing config (common in CI/builds)
if (
  (!firebaseConfig.apiKey || firebaseConfig.apiKey === "dummy-api-key") &&
  typeof window === "undefined"
) {
  console.warn("⚠️ Firebase Config: Running with missing or dummy credentials. This is expected during CI/Builds but critical features will fail in production.");
}

// Initialize Firebase (singleton pattern for Next.js)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);

// Store reCAPTCHA verifier
let recaptchaVerifier: RecaptchaVerifier | null = null;

export function getRecaptchaVerifier(containerId: string): RecaptchaVerifier {
  if (typeof window === "undefined") {
    throw new Error("RecaptchaVerifier can only be used in browser");
  }
  
  // Always create a new verifier to avoid stale state
  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // Ignore clear errors
    }
    recaptchaVerifier = null;
  }

  // Make sure the container exists
  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`reCAPTCHA container '${containerId}' not found in DOM`);
  }
  
  recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
    size: "invisible",
    callback: () => {
      console.log("reCAPTCHA solved");
    },
    "expired-callback": () => {
      console.log("reCAPTCHA expired");
      resetRecaptcha();
    },
  });
  
  return recaptchaVerifier;
}

export function resetRecaptcha() {
  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // Ignore errors
    }
    recaptchaVerifier = null;
  }
}

export { app, auth };
