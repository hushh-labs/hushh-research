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
    } catch (e) {
      console.warn("Failed to read service account file:", e);
    }
  }

  // Fallback: Check for service account JSON in environment
  const serviceAccountEnv = resolveServerFirebaseAdminCredentialsJson();

  if (serviceAccountEnv) {
    try {
      const parsedServiceAccount = JSON.parse(serviceAccountEnv);
      console.log("✅ Firebase Admin initialized from env variable");
      return admin.initializeApp({
        credential: admin.credential.cert(parsedServiceAccount),
      });
    } catch (e) {
      console.warn(`Failed to parse ${DEFAULT_SERVICE_ACCOUNT_ENV}:`, e);
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

export { admin, auth };

/**
 * Verify a Firebase ID token
 */
export async function verifyIdToken(idToken: string) {
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    return { valid: true, uid: decodedToken.uid, decodedToken };
  } catch (error) {
    console.error("Token verification failed:", error);
    return { valid: false, uid: null, decodedToken: null };
  }
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
