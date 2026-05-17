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

const disablePhoneAuthAppVerificationForTesting =
  process.env.NEXT_PUBLIC_APP_ENV === "development" &&
  process.env.NEXT_PUBLIC_FIREBASE_PHONE_AUTH_DISABLE_APP_VERIFICATION === "true";

if (disablePhoneAuthAppVerificationForTesting) {
  auth.settings.appVerificationDisabledForTesting = true;
}

// Store reCAPTCHA verifier
let recaptchaVerifier: RecaptchaVerifier | null = null;
let recaptchaWidgetId: number | null = null;

function getWindowWithRecaptcha() {
  return window as typeof window & {
    grecaptcha?: {
      reset: (widgetId?: number) => void;
    };
  };
}

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
    recaptchaWidgetId = null;
  }

  // Make sure the container exists
  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`reCAPTCHA container '${containerId}' not found in DOM`);
  }

  // Replace the container element entirely with a fresh node.
  // Google's reCAPTCHA library tracks which DOM elements have been rendered
  // in an internal registry keyed by element reference. Clearing children
  // or calling .clear() does not remove the element from that registry,
  // so re-rendering on the same element throws
  // "reCAPTCHA has already been rendered in this element".
  // Swapping in a brand-new element with the same id sidesteps the registry.
  const freshContainer = document.createElement("div");
  freshContainer.id = containerId;
  for (const cls of Array.from(container.classList)) {
    freshContainer.classList.add(cls);
  }
  container.replaceWith(freshContainer);

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

export async function prepareRecaptchaVerifier(containerId: string): Promise<RecaptchaVerifier> {
  const verifier = getRecaptchaVerifier(containerId);
  recaptchaWidgetId = await verifier.render();
  return verifier;
}

export function resetRecaptcha() {
  if (recaptchaVerifier) {
    try {
      if (recaptchaWidgetId !== null) {
        getWindowWithRecaptcha().grecaptcha?.reset(recaptchaWidgetId);
      }
      recaptchaVerifier.clear();
    } catch {
      // Ignore errors
    }
    recaptchaVerifier = null;
    recaptchaWidgetId = null;
  }

  // Also replace the container element so Google's internal registry
  // does not retain a reference to the old element.
  const container = document.getElementById("recaptcha-container");
  if (container) {
    const freshContainer = document.createElement("div");
    freshContainer.id = "recaptcha-container";
    for (const cls of Array.from(container.classList)) {
      freshContainer.classList.add(cls);
    }
    container.replaceWith(freshContainer);
  }
}

export { app, auth };
