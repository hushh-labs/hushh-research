"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "firebase/auth";
import { Capacitor } from "@capacitor/core";
import { AuthService } from "@/lib/services/auth-service";
import { useAuth } from "@/hooks/use-auth";
import { preloadGoogleSignupAuth } from "@/lib/auth/google-signup-token";
import {
  AccountService,
  type LostVaultDeleteOptions,
  type LostVaultDeletionReview,
} from "@/lib/services/account-service";
import { buildLoginRouteWithAuthSessionNotice } from "@/lib/auth/session-invalidation";
import { apiErrorCode } from "@/lib/services/api-client";
import { DELETION_PHONE_COUNTRIES, identityMessage, phoneMessage } from "./lost-vault-delete-details";
export { DELETION_PHONE_COUNTRIES } from "./lost-vault-delete-details";
import { getAuthSessionGeneration, snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import {
  prepareRecaptchaVerifier,
  resetRecaptcha,
} from "@/lib/firebase/config";
import {
  executeLostVaultAccountDeletion,
  lostVaultDeletionErrorMessage,
} from "@/lib/flows/delete-account";
import {
  derivePhoneFields,
  getPhoneNumberValidationError,
  resolvePhoneInputChange,
} from "@/components/auth/phone-verification-flow";

export type DeletionStage =
  | "review"
  | "phone"
  | "confirm"
  | "deleting"
  | "requested"
  | "pending"
  | "retained"
  | "ready"
  | "uncertain";
export type DeletionProvider = "google.com" | "apple.com";
const RESEND_DELAY_MS = 30_000;

/** Proof state belongs to one mounted owner/session and one verification attempt. */
export function useLostVaultDelete(
  user: User,
  resolvePhone: () => Promise<string | null>,
  continuationId?: string,
) {
  const { signOut } = useAuth();
  const generation = getAuthSessionGeneration();
  const owner = useMemo(
    () => ({
      principal: snapshotValidatedAuthSessionPrincipal(),
      active: false,
      generation,
      attempt: 0,
      work: null as number | null,
      edited: false,
      submitted: false,
      phoneAttempt: null as string | null,
      phoneController: null as AbortController | null,
    }),
    [generation],
  );
  const ownerRef = useRef(owner);
  useLayoutEffect(() => {
    ownerRef.current = owner;
    owner.active = true;
    return () => {
      owner.active = false;
      owner.attempt += 1;
      owner.phoneController?.abort();
      if (owner.phoneAttempt) {
        void AuthService.cancelPhoneDeletionVerification(owner.phoneAttempt).catch(() => undefined);
        owner.phoneAttempt = null;
      }
      resetRecaptcha();
    };
  }, [owner]);
  const current = useCallback(
    () =>
      !!owner.principal && owner.principal.firebaseUid === user.uid &&
      isValidatedAuthSessionOwnerCurrent(owner.principal) && owner.active &&
      ownerRef.current === owner &&
      getAuthSessionGeneration() === owner.generation,
    [owner, user.uid],
  );
  const valid = (attempt: number) => current() && owner.attempt === attempt;
  const [options, setOptions] = useState<LostVaultDeleteOptions | null>(null);
  const [review, setReview] = useState<LostVaultDeletionReview | null>(null);
  const [stage, setStage] = useState<DeletionStage>("review");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerProof, setProviderProof] = useState("");
  const [phoneProof, setPhoneProof] = useState("");
  const [verificationId, setVerificationId] = useState("");
  const [code, setCode] = useState("");
  const [country, setCountry] = useState("US");
  const [number, setNumber] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [loadRevision, setLoadRevision] = useState(0);
  const selectedCountry = DELETION_PHONE_COUNTRIES.find(
    (option) => option.value === country,
  )!;

  useEffect(() => {
    // Warm the existing singleton before the tap; loading it inside the click
    // would lose the browser's permission to open Google's account chooser.
    if (!Capacitor.isNativePlatform())
      void preloadGoogleSignupAuth().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const timer = setInterval(() => {
      if (current()) setNow(Date.now());
    }, 1000);
    const stop = setTimeout(
      () => {
        clearInterval(timer);
        if (current()) setNow(Date.now());
      },
      Math.max(0, resendAt - Date.now()),
    );
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [resendAt, current]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const token = await user.getIdToken();
        if (!current() || cancelled) return;
        const result = await AccountService.getLostVaultDeleteOptions(token);
        if (!current() || cancelled) return;
        setOptions(result);
        // Optional prefill never controls reachability and never overwrites an edit.
        if (result.phone_available)
          void resolvePhone()
            .then((phone) => {
              if (
                !current() ||
                cancelled ||
                owner.edited ||
                owner.attempt !== 0 ||
                !phone ||
                getPhoneNumberValidationError(phone)
              )
                return;
              const hint = result.phone_hint?.replace(/\D/g, "");
              if (hint && !phone.replace(/\D/g, "").endsWith(hint)) return;
              const fields = derivePhoneFields(phone);
              setCountry(fields.countryValue);
              setNumber(fields.localPhoneNumber);
            })
            .catch(() => undefined);
      } catch {
        if (current() && !cancelled)
          setError("We could not load deletion options. Try again.");
      } finally {
        if (current() && !cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current, loadRevision, owner, resolvePhone, user]);

  function begin(): number | null {
    if (!current() || owner.work !== null || owner.submitted) return null;
    const attempt = ++owner.attempt;
    owner.work = attempt;
    setBusy(true);
    setError(null);
    return attempt;
  }
  function finish(attempt: number) {
    if (current() && owner.work === attempt) {
      owner.work = null;
      setBusy(false);
    }
  }
  function clearPhoneProof() {
    owner.phoneController?.abort(); owner.phoneController = null;
    if (owner.phoneAttempt) {
      void AuthService.cancelPhoneDeletionVerification(owner.phoneAttempt).catch(() => undefined);
      owner.phoneAttempt = null;
    }
    setVerificationId("");
    setPhoneProof("");
    setCode("");
    setAcknowledged(false);
    setReview(null);
  }
  function editNumber(value: string, countryValue?: string) {
    if (!current() || owner.submitted) return;
    owner.edited = true;
    owner.attempt += 1;
    const fields = resolvePhoneInputChange(value);
    setNumber(fields.localPhoneNumber);
    if (countryValue || fields.countryValue)
      setCountry(countryValue ?? fields.countryValue!);
    clearPhoneProof();
    setError(null);
    resetRecaptcha();
  }
  function requireReauthentication() {
    clearPhoneProof();
    setProviderProof("");
    setStage("review");
    setError("Your sign-in check expired. Verify your account again.");
  }

  async function prepareFinalReview(
    token: string, phoneToken: string | undefined, attempt: number,
  ) {
    try {
      const result = await AccountService.reviewLostVaultDeletion({
        firebaseIdToken: token,
        phoneIdToken: phoneToken,
        continuationId,
        isCurrent: () => valid(attempt),
      });
      if (!valid(attempt)) return;
      if (!/^[0-9a-f]{64}$/.test(result.inventory_sha256) ||
          !Number.isInteger(result.credential_count) || result.credential_count < 0 ||
          typeof result.local_erasure_required !== "boolean") {
        throw new Error("invalid cleanup review");
      }
      setReview(result);
      setStage("confirm");
    } catch {
      if (!valid(attempt)) return;
      clearPhoneProof();
      setProviderProof("");
      setStage("review");
      setError("We couldn’t review deletion. Verify your account again.");
    }
  }

  async function verifyProvider(provider: DeletionProvider) {
    const attempt = begin();
    if (attempt === null) return;
    clearPhoneProof();
    setProviderProof("");
    try {
      const token = await AuthService.reauthenticateAccountDeletionIdentity(
        user.uid,
        provider,
        () => valid(attempt),
      );
      if (!valid(attempt)) return;
      // The provider may leave Chrome on its tab after settling. Ask the
      // browser to bring this original deletion panel forward before the next step.
      try {
        window.focus();
      } catch {
        // Focus is best effort and must not invalidate a verified owner.
      }
      const freshOptions =
        await AccountService.getLostVaultDeleteOptions(token);
      if (!valid(attempt)) return;
      setOptions(freshOptions);
      setProviderProof(token);
      if (freshOptions.phone_available) setStage("phone");
      else await prepareFinalReview(token, undefined, attempt);
    } catch (cause) {
      if (valid(attempt)) setError(identityMessage(cause));
    } finally {
      finish(attempt);
    }
  }

  async function sendCode() {
    if (!providerProof || !options?.phone_available || Date.now() < resendAt)
      return;
    const phone = `${selectedCountry.dialCode}${number}`;
    const validationError = getPhoneNumberValidationError(phone, country);
    if (validationError) {
      setError(validationError);
      return;
    }
    const resendCode = Boolean(verificationId);
    const attempt = begin();
    if (attempt === null) return;
    clearPhoneProof();
    try {
      const match = await AccountService.validateLostVaultDeletionPhone(
        providerProof,
        phone,
      );
      if (!valid(attempt)) return;
      if (match.valid !== true) throw new Error("phone_unavailable");
      const verifier = Capacitor.isNativePlatform()
        ? undefined
        : await prepareRecaptchaVerifier("lost-vault-delete-recaptcha");
      if (!valid(attempt)) return;
      const phoneAttempt = crypto.randomUUID();
      owner.phoneAttempt = phoneAttempt;
      owner.phoneController = new AbortController();
      const result = await AuthService.startPhoneDeletionVerification(
        phone,
        verifier,
        { expectedUserId: user.uid, attemptId: phoneAttempt, signal: owner.phoneController.signal, ...(resendCode ? { resendCode: true } : {}) },
      );
      if (!valid(attempt)) return;
      if ("phoneIdToken" in result) {
        owner.phoneAttempt = null;
        setPhoneProof(result.phoneIdToken);
        await prepareFinalReview(providerProof, result.phoneIdToken, attempt);
      } else setVerificationId(result.verificationId);
      setResendAt(Date.now() + RESEND_DELAY_MS);
      setNow(Date.now());
    } catch (cause) {
      if (!valid(attempt)) return;
      clearPhoneProof();
      if (apiErrorCode(cause) === "ACCOUNT_DELETE_REAUTH_REQUIRED")
        requireReauthentication();
      else setError(phoneMessage(cause, true));
      resetRecaptcha();
    } finally {
      finish(attempt);
    }
  }

  async function verifyCode() {
    if (!verificationId || !owner.phoneAttempt || !/^\d{6}$/.test(code)) return;
    const attempt = begin();
    if (attempt === null) return;
    try {
      const proof = await AuthService.confirmPhoneDeletionVerification({
        expectedUserId: user.uid,
        attemptId: owner.phoneAttempt!,
        verificationCode: code,
        verificationId,
      });
      if (!valid(attempt)) return;
      owner.phoneAttempt = null;
      setPhoneProof(proof);
      await prepareFinalReview(providerProof, proof, attempt);
    } catch (cause) {
      if (valid(attempt)) setError(phoneMessage(cause, false));
    } finally {
      finish(attempt);
    }
  }

  async function deleteAccount() {
    if (
      !acknowledged ||
      !providerProof ||
      !review ||
      (options?.phone_available && !phoneProof)
    )
      return;
    const attempt = begin();
    if (attempt === null) return;
    owner.submitted = true;
    setStage("deleting");
    try {
      const result = await executeLostVaultAccountDeletion({
        userId: owner.principal!.ownerId,
        owner: owner.principal!,
        sessionUser: user,
        firebaseIdToken: providerProof,
        phoneIdToken: phoneProof || undefined,
        continuationId,
        reviewedInventorySha256: review.inventory_sha256,
        acceptLocalErasure: review.local_erasure_required,
        isCurrent: () => valid(attempt),
      });
      if (!valid(attempt)) return;
      if (result.cleanup_pending === true && result.account_deleted === false &&
          result.cleanup_operation?.local_erasure_confirmation_required === false) {
        setStage("requested");
        try {
          await signOut({
            redirectTo: buildLoginRouteWithAuthSessionNotice("account_deletion_requested"),
            expectedUserId: owner.principal!.ownerId,
          });
        } catch {
          // The submitted operation remains pending; never offer DELETE again.
        }
        return;
      }
      setStage(
        result.details?.firebase_auth_user === "identity_retained"
          ? "retained"
          : result.ready_to_start_fresh === true
            ? "ready"
            : result.account_deleted === false
              ? "requested"
              : "pending",
      );
    } catch (cause) {
      if (!valid(attempt)) return;
      if (
        (cause as { code?: unknown })?.code ===
        "ACCOUNT_DELETION_OUTCOME_UNCERTAIN"
      ) {
        setStage("uncertain");
        return;
      }
      owner.submitted = false;
      clearPhoneProof();
      setProviderProof("");
      setStage("review");
      setError(`Account not deleted. ${lostVaultDeletionErrorMessage(cause)}`);
    } finally {
      finish(attempt);
    }
  }

  function cancel() {
    owner.active = false;
    owner.attempt += 1;
    clearPhoneProof();
    setProviderProof("");
    resetRecaptcha();
  }
  return {
    options,
    review,
    stage,
    loading,
    busy,
    error,
    country,
    number,
    selectedCountry,
    verificationId,
    code,
    acknowledged,
    resendSeconds: Math.max(0, Math.ceil((resendAt - now) / 1000)),
    editNumber,
    setCode,
    setAcknowledged,
    verifyProvider,
    sendCode,
    verifyCode,
    deleteAccount,
    cancel,
    retryOptions: () => setLoadRevision((value) => value + 1),
    restartVerification: () => {
      owner.attempt += 1;
      clearPhoneProof();
      setProviderProof("");
      setStage("review");
      setError(null);
    },
    changePhone: () => {
      owner.attempt += 1;
      clearPhoneProof();
      setStage("phone");
      setError(null);
    },
  };
}
