import { Capacitor } from "@capacitor/core";
import { getApps, initializeApp } from "firebase/app";
import {
  type ApplicationVerifier,
  PhoneAuthProvider,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithCredential,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { app, auth } from "@/lib/firebase/config";
import { HushhAuth } from "@/lib/capacitor";

export type PhoneDeletionContext = { expectedUserId: string; attemptId: string };
export type PhoneClaimConfirmation = {
  verificationCode: string;
  verificationId?: string | null;
};
export type PhoneDeletionConfirmation = PhoneDeletionContext & {
  verificationId: string;
  verificationCode: string;
};
type NormalizeError = (error: unknown) => Error;
const PHONE_CLAIM_APP_NAME = "hushh-phone-claim";

/** Send a one-time phone proof without adding, replacing, or unlinking a phone. */
export async function startDeletionPhoneProof(
  phoneNumber: string,
  recaptchaVerifier: ApplicationVerifier | undefined,
  context: PhoneDeletionContext,
  normalizeError: NormalizeError,
): Promise<{ verificationId: string } | { phoneIdToken: string }> {
  const normalizedPhoneNumber = String(phoneNumber ?? "").trim();
  if (!normalizedPhoneNumber) throw new Error("phone_unavailable");
  try {
    if (Capacitor.isNativePlatform()) {
      const result = await HushhAuth.startPhoneDeletionVerification({
        ...context,
        phoneNumber: normalizedPhoneNumber,
      });
      if (result.attemptId !== context.attemptId)
        throw new Error("session_changed");
      if (result.phoneIdToken) return { phoneIdToken: result.phoneIdToken };
      if (result.verificationId === context.attemptId)
        return { verificationId: result.verificationId };
      throw new Error("phone_verification_failed");
    }
    const user = auth.currentUser;
    if (!user || user.uid !== context.expectedUserId) throw new Error("session_changed");
    if (!recaptchaVerifier) throw new Error("recaptcha_unavailable");
    const provider = new PhoneAuthProvider(auth);
    const verificationId = await provider.verifyPhoneNumber(normalizedPhoneNumber, recaptchaVerifier);
    if (auth.currentUser !== user) throw new Error("session_changed");
    return { verificationId };
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function confirmDeletionPhoneProof(
  params: PhoneDeletionConfirmation,
  normalizeError: NormalizeError,
): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    const user = auth.currentUser;
    if (!user || user.uid !== params.expectedUserId) throw new Error("session_changed");
    const token = await mintPhoneClaimIdToken(params, normalizeError);
    if (auth.currentUser !== user) throw new Error("session_changed");
    return token;
  }
  try {
    const result = await HushhAuth.confirmPhoneDeletionVerification({
      expectedUserId: params.expectedUserId,
      attemptId: params.attemptId,
      verificationCode: params.verificationCode,
    });
    if (result.attemptId !== params.attemptId)
      throw new Error("session_changed");
    if (!result.phoneIdToken) throw new Error("phone_verification_failed");
    return result.phoneIdToken;
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function cancelDeletionPhoneProof(attemptId: string): Promise<void> {
  if (Capacitor.isNativePlatform())
    await HushhAuth.cancelPhoneDeletionVerification({ attemptId });
}

export async function mintPhoneClaimIdToken(
  params: PhoneClaimConfirmation,
  normalizeError: NormalizeError,
): Promise<string> {
  const verificationCode = String(params.verificationCode ?? "").trim();
  if (!verificationCode) {
    throw new Error("Verification code is required.");
  }

  if (Capacitor.isNativePlatform()) {
    throw new Error("Phone claim token minting is only supported on web.");
  }

  const verificationId = String(params.verificationId ?? "").trim();
  if (!verificationId) {
    throw new Error("Verification ID is required.");
  }

  const credential = PhoneAuthProvider.credential(
    verificationId,
    verificationCode,
  );
  const secondaryApp =
    getApps().find(
      (firebaseApp) => firebaseApp.name === PHONE_CLAIM_APP_NAME,
    ) || initializeApp(app.options, PHONE_CLAIM_APP_NAME);
  const phoneClaimAuth = getAuth(secondaryApp);

  await setPersistence(phoneClaimAuth, inMemoryPersistence);

  let claimToken = "";
  try {
    const result = await signInWithCredential(phoneClaimAuth, credential);
    claimToken = await result.user.getIdToken(true);
  } catch (error) {
    throw normalizeError(error);
  } finally {
    await firebaseSignOut(phoneClaimAuth).catch(() => undefined);
  }

  if (!claimToken) {
    throw new Error(
      "Phone verification completed but no claim token was returned.",
    );
  }

  return claimToken;
}
