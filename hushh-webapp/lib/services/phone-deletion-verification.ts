import { Capacitor } from "@capacitor/core";
import { getApps, initializeApp } from "firebase/app";
import {
  type ApplicationVerifier,
  PhoneAuthProvider,
  PhoneAuthCredential,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithCredential,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { app, auth } from "@/lib/firebase/config";
import { HushhAuth } from "@/lib/capacitor";
import type { PhoneLinkConflict } from "./firebase-phone-link";
import type { PhoneLinkIntent } from "@/lib/capacitor/types/auth";

export type PhoneDeletionContext = { expectedUserId: string; attemptId: string; resendCode?: boolean; signal?: AbortSignal };
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
const MANUAL_PROOF_PREFIX = "native-phone-proof:";
let manualAttempt: (PhoneDeletionContext & { dispose: () => void; intent: PhoneLinkIntent; phoneNumber: string; expiresAt: number; providerVerificationId?: string }) | null = null;
const deletionCancellations = new Map<string, () => void>();

/** One send budget covers native restore, previous cancellation and SDK dispatch. */
export async function withNativePhoneProofStart<T>(
  signal: AbortSignal | undefined,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const cancelled = () => Object.assign(new Error("Your signed-in account changed. Start phone verification again."), { code: "session_changed" });
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  let interrupt!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { interrupt = reject; });
  const abort = () => { controller.abort(); interrupt(cancelled()); };
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => {
    controller.abort();
    interrupt(Object.assign(new Error("Sending the verification code took too long. Request a new code."), {
      code: "phone-verification-start-timeout",
    }));
  }, 120_000);
  try {
    return await Promise.race([start(controller.signal), stopped]);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
  }
}

/** Reuse the native attempt fence for a primary-provider mutation. */
export async function startManualPhoneProof({
  phoneNumber, expectedUserId, intent, signal, resendCode = false, ownerSignal = signal,
}: {
  phoneNumber: string;
  expectedUserId: string;
  intent: PhoneLinkIntent;
  signal?: AbortSignal;
  resendCode?: boolean;
  ownerSignal?: AbortSignal;
}): Promise<{ autoVerified: false; verificationId: string }> {
  const previous = manualAttempt;
  if (previous) {
    manualAttempt = null; previous.dispose();
    await HushhAuth.cancelPhoneVerificationProof({ attemptId: previous.attemptId });
  }
  if (signal?.aborted) throw new Error("session_changed");
  const attemptId = crypto.randomUUID();
  const signals = [...new Set([signal, ownerSignal])];
  const dispose = () => signals.forEach(value => value?.removeEventListener("abort", cancel));
  const cancel = () => {
    if (manualAttempt?.attemptId === attemptId) manualAttempt = null;
    dispose();
    void HushhAuth.cancelPhoneVerificationProof({ attemptId }).catch(() => undefined);
  };
  manualAttempt = { expectedUserId, attemptId, dispose, intent, phoneNumber, expiresAt: performance.now() + 300_000 };
  signals.forEach(value => value?.addEventListener("abort", cancel, { once: true }));
  try {
    let result;
    try {
      result = await HushhAuth.startPhoneLinkVerification({ expectedUserId, attemptId, phoneNumber, resendCode, linkIntent: intent });
    } catch (error) {
      if (String((error as { code?: unknown })?.code).toUpperCase() === "UNIMPLEMENTED") {
        throw Object.assign(new Error("Update the app to verify a phone number."), { code: "phone-link-upgrade-required" });
      }
      throw error;
    }
    if (manualAttempt?.attemptId !== attemptId || signals.some(value => value?.aborted) || result.attemptId !== attemptId || result.verificationId !== attemptId)
      throw new Error("session_changed");
    // Qualify the new bridge response before admitting its provider challenge.
    if (result.linkIntent !== intent || !result.providerVerificationId) {
      throw Object.assign(new Error("Update the app to verify a phone number."), { code: "phone-link-upgrade-required" });
    }
    manualAttempt.providerVerificationId = result.providerVerificationId;
    return { autoVerified: false, verificationId: `${MANUAL_PROOF_PREFIX}${attemptId}` };
  } catch (error) { cancel(); throw error; }
}

export function readManualPhoneLinkChallenge(params: {
  verificationId: string;
  expectedUserId: string;
  phoneNumber: string;
  intent: PhoneLinkIntent;
}) {
  const current = manualAttempt;
  if (!current?.providerVerificationId || performance.now() >= current.expiresAt || current.intent !== params.intent ||
      params.expectedUserId !== current.expectedUserId || params.phoneNumber !== current.phoneNumber ||
      params.verificationId !== `${MANUAL_PROOF_PREFIX}${current.attemptId}`) {
    throw Object.assign(new Error("Request a new verification code."), { code: "phone-verification-required" });
  }
  return {
    providerVerificationId: current.providerVerificationId,
    isCurrent: () => manualAttempt === current && performance.now() < current.expiresAt,
  };
}

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
      return await withNativePhoneProofStart(context.signal, async signal => {
        const dispose = trackDeletionCancellation(context.attemptId, [signal, context.signal]);
        try {
          const result = await HushhAuth.startPhoneDeletionVerification({
            expectedUserId: context.expectedUserId, attemptId: context.attemptId,
            resendCode: context.resendCode, phoneNumber: normalizedPhoneNumber,
          });
          if (signal.aborted || context.signal?.aborted || result.attemptId !== context.attemptId)
            throw new Error("session_changed");
          if (result.phoneIdToken) { dispose(); return { phoneIdToken: result.phoneIdToken }; }
          if (result.verificationId === context.attemptId)
            return { verificationId: result.verificationId };
          throw new Error("phone_verification_failed");
        } catch (error) {
          dispose();
          void HushhAuth.cancelPhoneDeletionVerification({ attemptId: context.attemptId }).catch(() => undefined);
          throw error;
        }
      });
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
    if (params.signal?.aborted) throw new Error("session_changed");
    const result = await HushhAuth.confirmPhoneDeletionVerification({
      expectedUserId: params.expectedUserId,
      attemptId: params.attemptId,
      verificationCode: params.verificationCode,
    });
    if (params.signal?.aborted || result.attemptId !== params.attemptId)
      throw new Error("session_changed");
    if (!result.phoneIdToken) throw new Error("phone_verification_failed");
    deletionCancellations.get(params.attemptId)?.();
    return result.phoneIdToken;
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function cancelDeletionPhoneProof(attemptId: string): Promise<void> {
  deletionCancellations.get(attemptId)?.();
  if (Capacitor.isNativePlatform())
    await HushhAuth.cancelPhoneDeletionVerification({ attemptId });
}

/** Listener ownership is metadata only; the native helper owns proof validity. */
function trackDeletionCancellation(attemptId: string, signals: (AbortSignal | undefined)[]): () => void {
  deletionCancellations.get(attemptId)?.();
  const unique = [...new Set(signals)];
  const dispose = () => {
    unique.forEach(signal => signal?.removeEventListener("abort", cancel));
    if (deletionCancellations.get(attemptId) === dispose) deletionCancellations.delete(attemptId);
  };
  const cancel = () => {
    dispose();
    void HushhAuth.cancelPhoneDeletionVerification({ attemptId }).catch(() => undefined);
  };
  deletionCancellations.set(attemptId, dispose);
  unique.forEach(signal => signal?.addEventListener("abort", cancel, { once: true }));
  return dispose;
}

export async function mintPhoneClaimIdToken(
  params: PhoneClaimConfirmation | PhoneLinkConflict,
  normalizeError: NormalizeError,
): Promise<string> {
  let credential;
  if ("temporaryProof" in params) {
    credential = PhoneAuthCredential.fromJSON(params);
    if (!credential) throw new Error("Request a new verification code.");
  } else {
    const verificationCode = String(params.verificationCode ?? "").trim();
    if (!verificationCode) {
      throw new Error("Verification code is required.");
    }

    const verificationId = String(params.verificationId ?? "").trim();
    if (!verificationId) {
      throw new Error("Verification ID is required.");
    }

    credential = PhoneAuthProvider.credential(verificationId, verificationCode);
  }
  const secondaryApp =
    getApps().find(
      (firebaseApp) => firebaseApp.name === PHONE_CLAIM_APP_NAME,
    ) || initializeApp(app.options, PHONE_CLAIM_APP_NAME);
  const phoneClaimAuth = getAuth(secondaryApp);

  await setPersistence(phoneClaimAuth, inMemoryPersistence);

  let claimToken = "";
  try {
    const result = await signInWithCredential(phoneClaimAuth, credential);
    if ("temporaryProof" in params && result.user.phoneNumber !== params.phoneNumber) {
      throw new Error("The verified phone changed. Request a new code.");
    }
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
