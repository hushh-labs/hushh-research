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
import {
  AccountService,
  type LostVaultDeleteOptions,
} from "@/lib/services/account-service";
import { apiErrorCode } from "@/lib/services/api-client";
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
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import {
  getCountryCallingCode,
  isSupportedCountry,
  type CountryCode,
} from "libphonenumber-js/core";
import mobileMetadata from "libphonenumber-js/mobile/metadata";

export type DeletionStage =
  | "review"
  | "phone"
  | "confirm"
  | "deleting"
  | "pending"
  | "retained"
  | "ready"
  | "uncertain";
export type DeletionProvider = "google.com" | "apple.com";
// Use the same numbering plans as the existing phone-entry UI, including NANP.
export const DELETION_PHONE_COUNTRIES = COUNTRY_PHONE_OPTIONS.filter((option) =>
  isSupportedCountry(option.value as CountryCode, mobileMetadata),
).map((option) => ({
  ...option,
  dialCode: `+${getCountryCallingCode(option.value as CountryCode, mobileMetadata)}`,
}));
const RESEND_DELAY_MS = 30_000;

function identityMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "identity_cancelled")
    return "Sign-in check cancelled. Try again.";
  if (code === "identity_popup_blocked")
    return "Allow the sign-in window, then try again.";
  if (code === "native_identity_unavailable")
    return "Use One on the web, or contact support.";
  if (code === "session_changed" || code === "identity_mismatch")
    return "Your account changed. Sign in again.";
  return "We could not verify you. Try again.";
}

function phoneMessage(error: unknown, sending: boolean): string {
  switch (apiErrorCode(error)) {
    case "ACCOUNT_DELETE_PHONE_MISMATCH":
      return "That number does not match your linked phone. Check the full number and country code.";
    case "ACCOUNT_DELETE_PHONE_INVALID":
      return "Enter a valid mobile number and country code.";
    case "ACCOUNT_DELETE_PHONE_BINDING_CONFLICT":
      return "Your linked phone records disagree. No code was sent. Contact support.";
    case "ACCOUNT_DELETE_METHOD_UNAVAILABLE":
      return "Your account’s phone changed. Go back and verify your account again.";
    case "ACCOUNT_DELETE_VERIFICATION_UNAVAILABLE":
      return "We could not check your linked phone. Try again.";
  }
  const code = String((error as { code?: unknown })?.code ?? "").replace(
    /^auth\//,
    "",
  );
  if (code === "code-expired" || code === "session-expired")
    return "This code expired. Request a new code.";
  if (code === "invalid-verification-code")
    return "That code is incorrect. Check it and try again.";
  if (code === "too-many-requests")
    return "Too many attempts. Wait a moment before requesting another code.";
  return sending
    ? "We could not send the code. Try again."
    : "That code did not work. Try again or request a new code.";
}

/** Proof state belongs to one mounted owner/session and one verification attempt. */
export function useLostVaultDelete(
  user: User,
  resolvePhone: () => Promise<string | null>,
) {
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
    if (owner.phoneAttempt) {
      void AuthService.cancelPhoneDeletionVerification(owner.phoneAttempt).catch(() => undefined);
      owner.phoneAttempt = null;
    }
    setVerificationId("");
    setPhoneProof("");
    setCode("");
    setAcknowledged(false);
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

  async function verifyProvider(provider: DeletionProvider) {
    const attempt = begin();
    if (attempt === null) return;
    clearPhoneProof();
    setProviderProof("");
    try {
      const token = await AuthService.reauthenticateAccountDeletionIdentity(
        user.uid,
        provider,
        current,
      );
      if (!valid(attempt)) return;
      const freshOptions =
        await AccountService.getLostVaultDeleteOptions(token);
      if (!valid(attempt)) return;
      setOptions(freshOptions);
      setProviderProof(token);
      setStage(freshOptions.phone_available ? "phone" : "confirm");
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
      const result = await AuthService.startPhoneDeletionVerification(
        phone,
        verifier,
        { expectedUserId: user.uid, attemptId: phoneAttempt },
      );
      if (!valid(attempt)) return;
      if ("phoneIdToken" in result) {
        owner.phoneAttempt = null;
        setPhoneProof(result.phoneIdToken);
        setStage("confirm");
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
      setStage("confirm");
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
        isCurrent: () => valid(attempt),
      });
      if (!valid(attempt)) return;
      setStage(
        result.details?.firebase_auth_user === "identity_retained"
          ? "retained"
          : result.ready_to_start_fresh === true
            ? "ready"
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
