/**
 * Firebase Admin SDK Configuration
 * =================================
 *
 * Server-side Firebase Admin for:
 * - Verifying ID tokens
 * - Creating session cookies
 * - Managing server-side auth
 *
 * SECURITY: Never import this in client-side code
 */

import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";
import {
  FIREBASE_ADMIN_CREDENTIALS_JSON_ENV,
  resolveServerFirebaseAdminCredentialsJson,
} from "@/lib/runtime/settings";

const DEFAULT_SERVICE_ACCOUNT_ENV = FIREBASE_ADMIN_CREDENTIALS_JSON_ENV;

// Initialize Firebase Admin (only once)
function initializeFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.apps[0]!;
  }

  // Try to read from file first (more reliable than env variable for complex JSON)
  const serviceAccountPath = path.join(process.cwd(), "firebase-service-account.json");
  
  if (fs.existsSync(serviceAccountPath)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      console.log("✅ Firebase Admin initialized from service account file");
      return admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } catch (_e) {
      console.warn("Failed to read service account file");
    }
  }

  // Fallback: Check for service account JSON in environment
  const serviceAccountEnv = resolveServerFirebaseAdminCredentialsJson();

  if (serviceAccountEnv) {
  try {
    const parsedServiceAccount = JSON.parse(serviceAccountEnv);

    if (
      !parsedServiceAccount ||
      typeof parsedServiceAccount.project_id !== "string" ||
      typeof parsedServiceAccount.client_email !== "string" ||
      typeof parsedServiceAccount.private_key !== "string"
    ) {
      console.warn(
        `[FirebaseAdmin] Skipping ${DEFAULT_SERVICE_ACCOUNT_ENV}: missing required service account fields.`
      );
    } else {
      console.log("✅ Firebase Admin initialized from env variable");
      return admin.initializeApp({
        credential: admin.credential.cert(parsedServiceAccount),
      });
    }
  } catch (_e) {
    console.warn(
      `[FirebaseAdmin] Skipping ${DEFAULT_SERVICE_ACCOUNT_ENV}: invalid JSON.`
    );
  }
}

  // Fallback: Use application default credentials (for Cloud Run, etc.)
  console.log("ℹ️ Firebase Admin using application default credentials");
  return admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

// Get or initialize the app
const app = initializeFirebaseAdmin();
const auth = admin.auth(app);
const FIREBASE_ADMIN_VERIFY_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export { admin, auth };

type VerifyIdTokenResult = {
  valid: boolean;
  uid: string | null;
  decodedToken: admin.auth.DecodedIdToken | null;
  error?: string;
  unavailable?: boolean;
};

/**
 * In-process cache of successful ID token verifications.
 *
 * Why this exists
 * ---------------
 * `auth.verifyIdToken()` fetches and validates against Google's public signing
 * keys. The first verification (and every verification after the Admin SDK's
 * key cache is dropped, which happens frequently under the dev server's module
 * reloading) performs a network round-trip that has been observed to take
 * several seconds. The vault unlock screen issues two authenticated proxy
 * calls back to back (`/api/vault/check` then `/api/vault/get`), and without a
 * cache each pays that cost and they serialize on the single Node event loop,
 * producing ~10s+ stalls and the intermittent "second load fails" behaviour.
 *
 * Safety
 * ------
 * Only SUCCESSFUL verifications are cached. The cache entry is keyed by the
 * exact token string and expires at the token's own `exp` claim (never later),
 * so this never extends a token's validity or accepts an expired/invalid token.
 * Concurrent verifications of the same token are de-duplicated so the two
 * vault calls on one page load share a single SDK verification.
 */
const VERIFIED_TOKEN_CACHE = new Map<
  string,
  { result: VerifyIdTokenResult; expiresAtMs: number }
>();
const VERIFY_INFLIGHT = new Map<string, Promise<VerifyIdTokenResult>>();
// Small safety margin so a token never serves from cache right up to its exact
// expiry instant.
const VERIFIED_TOKEN_CACHE_SKEW_MS = 5_000;

function getCachedVerification(idToken: string): VerifyIdTokenResult | null {
  const entry = VERIFIED_TOKEN_CACHE.get(idToken);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAtMs) {
    VERIFIED_TOKEN_CACHE.delete(idToken);
    return null;
  }
  return entry.result;
}

function cacheVerification(idToken: string, result: VerifyIdTokenResult): void {
  // Only cache valid results with a usable expiry from the token itself.
  const expSeconds = result.decodedToken?.exp;
  if (!result.valid || typeof expSeconds !== "number") return;
  const expiresAtMs = expSeconds * 1000 - VERIFIED_TOKEN_CACHE_SKEW_MS;
  if (expiresAtMs <= Date.now()) return;
  VERIFIED_TOKEN_CACHE.set(idToken, { result, expiresAtMs });
}

async function runVerifyIdToken(idToken: string): Promise<VerifyIdTokenResult> {
  try {
    const decodedToken = await withTimeout(
      auth.verifyIdToken(idToken),
      FIREBASE_ADMIN_VERIFY_TIMEOUT_MS,
      "Firebase ID token verification"
    );
    return { valid: true, uid: decodedToken.uid, decodedToken };
  } catch (error) {
    console.error("Token verification failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      uid: null,
      decodedToken: null,
      error: message,
      unavailable:
        message.toLowerCase().includes("timed out") ||
        message.toLowerCase().includes("network") ||
        message.toLowerCase().includes("enotfound") ||
        message.toLowerCase().includes("fetch failed"),
    };
  }
}

/**
 * Verify a Firebase ID token
 */
export async function verifyIdToken(
  idToken: string
): Promise<VerifyIdTokenResult> {
  const cached = getCachedVerification(idToken);
  if (cached) return cached;

  // De-duplicate concurrent verifications of the same token (e.g. the vault
  // check + get calls fired together on one page load).
  const inflight = VERIFY_INFLIGHT.get(idToken);
  if (inflight) return inflight;

  const promise = runVerifyIdToken(idToken)
    .then((result) => {
      cacheVerification(idToken, result);
      return result;
    })
    .finally(() => {
      if (VERIFY_INFLIGHT.get(idToken) === promise) {
        VERIFY_INFLIGHT.delete(idToken);
      }
    });

  VERIFY_INFLIGHT.set(idToken, promise);
  return promise;
}

/**
 * Create a session cookie from an ID token
 * @param idToken - Firebase ID token from client
 * @param expiresIn - Cookie expiration in milliseconds (default: 5 days)
 */
export async function createSessionCookie(
  idToken: string,
  expiresIn: number = 5 * 24 * 60 * 60 * 1000 // 5 days
) {
  try {
    const sessionCookie = await auth.createSessionCookie(idToken, {
      expiresIn,
    });
    return { success: true, sessionCookie };
  } catch (error) {
    console.error("Session cookie creation failed:", error);
    return { success: false, sessionCookie: null };
  }
}

/**
 * Verify a session cookie
 */
export async function verifySessionCookie(
  sessionCookie: string,
  checkRevoked = true
) {
  try {
    const decodedClaims = await auth.verifySessionCookie(
      sessionCookie,
      checkRevoked
    );
    return { valid: true, uid: decodedClaims.uid, decodedClaims };
  } catch (error) {
    console.error("Session cookie verification failed:", error);
    return { valid: false, uid: null, decodedClaims: null };
  }
}
