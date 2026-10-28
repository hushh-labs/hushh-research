"use client";

import { performPhoneRecovery } from "./use-phone-recovery-handoff";
import { usePhoneLinkedDeletion } from "./use-phone-linked-deletion";
import type { LinkedDeletionInput } from "@/lib/auth/phone-linked-deletion";
import type { LinkedDeletionPreparation } from "@/lib/services/phone-recovery-service";

import { DEFAULT_COUNTRY_VALUE, DEFAULT_PHONE_COUNTRY_OPTION, E164_PHONE_PATTERN, PHONE_COUNTRY_OPTIONS, composePhoneNumber, derivePhoneFields, getCountryOption, getCountryOptionLabel, getMobileNumberLengthRange, getPhoneEntryError, getPhoneNumberValidationError, maskPhoneNumberForOtp, resolvePhoneInputChange } from "@/lib/auth/phone-input";
import type { CountryPhoneOption } from "@/lib/constants/country-phone-options";
import { formatMaskedPhoneNumber } from "@/lib/services/phone-display";
export { getMobileNumberLengthRange, derivePhoneFields, getPhoneNumberValidationError, maskPhoneNumberForOtp, resolvePhoneInputChange } from "@/lib/auth/phone-input";

import { Capacitor } from "@capacitor/core";

import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "firebase/auth";
import { resolveContactPhoneRegion } from "@/lib/contacts/phone-normalization";
import { Loader2, ShieldCheck } from "@/components/icons";
import { usePathname } from "next/navigation";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Button } from "@/lib/morphy-ux/button";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/lib/morphy-ux/ui/combobox";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { resolvePhoneFailureMessage } from "@/lib/auth/phone-conflict-copy";
import { apiErrorCode } from "@/lib/services/api-client";
import { trackEvent } from "@/lib/observability/client";
import {
  kaiAppCardTitleClassName,
  kaiAppHelperClassName,
} from "@/components/kai/shared/kai-typography";
import { FigmaCountryFlag } from "@/components/onboarding/FigmaOnboardingPrimitives";
import { CountryPicker, InlineCountryPickerPanel } from "@/components/auth/country-picker";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { PhoneConflictRecovery } from "@/components/auth/phone-conflict-recovery";

const FLOW_CONTROL_SHELL_CLASS_NAME =
  "h-[54px] overflow-hidden rounded-[15px] border-black/10 bg-[#f5f5f7]/92 shadow-xs transition-[border-color,box-shadow] focus-within:border-[color:var(--app-accent)] focus-within:ring-4 focus-within:ring-[color:var(--app-accent-ring)] dark:border-white/10 dark:bg-white/[0.08]";
const FLOW_CONTROL_CLASS_NAME =
  "type-callout h-full rounded-[inherit] border-0 bg-transparent px-4 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent";
const FLOW_SURFACE_RADIUS_CLASS_NAME = "rounded-[18px]";
// Theme-aware flat accent pill CTA (follows the accent preference: iOS Blue
// default, Molten Gold opt-in). No gradient, no decorative shadow.
const FLOW_CTA_CLASS_NAME =
  "h-[54px] rounded-full border-0 !bg-[var(--app-accent)] !text-[var(--app-accent-fg)] transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:!bg-[var(--app-accent-hover)] motion-reduce:transition-none";

export type PhoneVerificationFlowMode = "link" | "replace";

export type PhoneVerificationFlowProps = {
  mode: PhoneVerificationFlowMode;
  currentPhoneNumber?: string | null;
  startVerification: (
    phoneNumber: string,
    options?: { resendCode?: boolean; transport?: "sms" },
  ) => Promise<{ autoVerified: boolean; user?: User | null }>;
  confirmVerification: (otp: string) => Promise<User>;
  confirmTransfer?: () => Promise<User>;
  confirmLinkedDeletion?: (input: LinkedDeletionInput) => Promise<User>;
  prepareLinkedDeletion?: (phoneNumber: string) => Promise<LinkedDeletionPreparation>;
  cancelLinkedDeletion?: (operation: string) => Promise<unknown>;
  recoverPreviousAccount?: (phoneNumber: string) => Promise<void> | void;
  deletePreviousAccount?: (phoneNumber: string) => Promise<void> | void;
  revokePreviousAccountDevices?: (phoneNumber: string) => Promise<void> | void;
  onCompleted: (user?: User | null) => Promise<void> | void;
  onContinueExisting?: () => Promise<void> | void;
  onCancel?: () => void;
  sendCodeLabel?: string;
  confirmLabel?: string;
  codePresentation?: "default" | "onboarding";
  primaryActionClassName?: string;
  className?: string;
  helperText?: ReactNode;
  phonePresentation?: "default" | "compact";
  style?: CSSProperties;
  onStepChange?: (step: VerificationStep) => void;
  onBackStepChange?: (handler: (() => boolean) | null) => void;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
  /** Optional owning destination fence. Never a provider credential. */
  ownerKey?: string | symbol;
  isCurrent?: () => boolean;
  operationAllowed?: () => boolean;
};

type VerificationStep = "phone" | "code" | "linked";
type StartVerificationOutcome =
  | "code_sent"
  | "auto_verified"
  | "already_linked"
  | "invalid"
  | "failed"
  | "busy";

type ConfirmVerificationOutcome = "verified" | "invalid" | "failed" | "busy";

function phoneFailureMessage(error: unknown, fallback: string): string {
  return resolvePhoneFailureMessage(error, fallback, apiErrorCode(error));
}

export function usePhoneVerificationFlow({
  mode,
  currentPhoneNumber,
  startVerification,
  confirmVerification,
  confirmTransfer, confirmLinkedDeletion, prepareLinkedDeletion, cancelLinkedDeletion,
  recoverPreviousAccount,
  deletePreviousAccount, revokePreviousAccountDevices,
  onCompleted,
  onContinueExisting,
  codePresentation = "default",
  phonePresentation = "default",
  onStepChange,
  onBackStepChange,
  onNavigationGuardChange,
  ownerKey,
  isCurrent,
  operationAllowed,
}: PhoneVerificationFlowProps) {
  const pathname = usePathname();
  const [formOwner, setFormOwner] = useState(ownerKey);
  const visit = useMemo(() => ({ active: false, ownerKey, verified: false, verifiedUser: undefined as User | null | undefined, entryRevision: 0, smsTransport: false }), [ownerKey]);
  const entryRevision = visit.entryRevision;
  const [, publishEntryRevision] = useState(0);
  const advanceEntryRevision = useCallback(() => {
    visit.entryRevision += 1; publishEntryRevision(value => value + 1);
  }, [visit]);
  const currentOwner = useRef(isCurrent);
  const allowedOperation = useRef(operationAllowed);
  useLayoutEffect(() => { currentOwner.current = isCurrent; });
  useLayoutEffect(() => { allowedOperation.current = operationAllowed; });
  useLayoutEffect(() => { visit.active = true; return () => { visit.active = false; }; }, [visit]);
  const current = useCallback(() => visit.active && formOwner === ownerKey && currentOwner.current?.() !== false, [visit, formOwner, ownerKey]);
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_COUNTRY_VALUE);
  const [countryQuery, setCountryQuery] = useState("");
  const [countryComboboxOpen, setCountryComboboxOpen] = useState(false);
  const suppressNextCountryFocusOpenRef = useRef(false);
  const [localPhoneNumber, setLocalPhoneNumber] = useState("");
  const rejectedPhoneInputRef = useRef(false);
  const [phoneNumberError, setPhoneNumberError] = useState<string | null>(null);
  const [submittedPhoneNumber, setSubmittedPhoneNumber] = useState(
    currentPhoneNumber || "",
  );
  const [verificationCode, setVerificationCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<"choices" | "review" | "delete" | null>(null);
  const [transferPending, setTransferPending] = useState(false);
  const [transferEligible, setTransferEligible] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [step, setStep] = useState<VerificationStep>(
    mode === "link" && currentPhoneNumber ? "linked" : "phone",
  );
  const [busy, setBusy] = useState(false);
  // State updates do not land until after the current event. `busy` alone
  // cannot gate this: two different actions (Verify and Resend) fired in the
  // same render both read the same stale `busy=false` before either commits
  // its `setBusy(true)`. One shared ref -- set synchronously the instant an
  // attempt starts -- closes that cross-action race, not just same-action
  // double-clicks.
  const phoneFlowInFlightRef = useMemo(() => ({ current: false, visit }), [visit]);
  const transferGuard = useMemo(() => ({ pending: false, visit }), [visit]);
  const deletionGuard = useMemo(() => ({ pending: false, visit }), [visit]);
  useLayoutEffect(() => {
    onNavigationGuardChange?.(() => current() && (phoneFlowInFlightRef.current || transferGuard.pending || deletionGuard.pending));
    return () => onNavigationGuardChange?.(null);
  }, [current, onNavigationGuardChange, phoneFlowInFlightRef, transferGuard, deletionGuard]);

  // `step` read from an effect that must not re-run when it changes.
  const stepRef = useRef(step);
  const changeStep = useCallback((next: VerificationStep) => { stepRef.current = next; setStep(next); }, []);
  const deletion = usePhoneLinkedDeletion({ phone: submittedPhoneNumber, conflict, busy, guard: deletionGuard, current,
    inFlight: phoneFlowInFlightRef, setBusy, setConflict, setError: setOperationError,
    prepare: prepareLinkedDeletion, cancel: cancelLinkedDeletion, confirm: confirmLinkedDeletion,
    fallback: () => performPhoneRecovery(deletePreviousAccount, submittedPhoneNumber, current, phoneFlowInFlightRef, setBusy, setOperationError),
    onDeleted: async verified => { visit.verified = true; visit.verifiedUser = verified; setConflict(null); changeStep("linked"); await onCompleted(verified); } });
  const seededOwner = useRef(ownerKey);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  useLayoutEffect(() => {
    // A sent code outranks a late identity read.
    //
    // This effect exists to re-seed the form when the owner's number changes.
    // But `currentPhoneNumber` comes from the auth context, which resolves the
    // verified number from the backend in the background, and that can land
    // AFTER a code has been sent. Re-seeding then wipes `verificationCode` and
    // moves `step` off "code" -- taking away the only screen that can consume
    // the code the person is holding, with no way back except sending another.
    //
    // While a code is outstanding this screen owns its own state.
    if (seededOwner.current === ownerKey && (stepRef.current === "code" || visit.verified)) {
      return;
    }
    seededOwner.current = ownerKey;
    setFormOwner(ownerKey);
    const nextFields = derivePhoneFields(currentPhoneNumber);
    rejectedPhoneInputRef.current = false;
    setSelectedCountry(nextFields.countryValue);
    setLocalPhoneNumber(nextFields.localPhoneNumber);
    setPhoneNumberError(null);
    setSubmittedPhoneNumber(currentPhoneNumber || "");
    setCountryQuery("");
    setVerificationCode("");
    setCodeError(null); setOperationError(null); setBusy(false);
    setConflict(null); setTransferPending(false); transferGuard.pending = false; deletionGuard.pending = false;
    changeStep(mode === "link" && currentPhoneNumber ? "linked" : "phone");
  }, [currentPhoneNumber, mode, ownerKey, changeStep, visit, transferGuard, deletionGuard]);

  // Start on the person's own country, not on ours.
  //
  // This defaulted to "US" for everyone. Someone in India typing their real
  // mobile got it sent as +91... -> +1..., which is a different number: the
  // code goes nowhere, and a test-number allowlist keyed on E.164 never
  // matches. The picker was right there and looked deliberate, so the failure
  // read as "verification is broken" rather than "wrong country".
  //
  // Detection runs in an effect, never during render: `navigator` does not
  // exist on the server, and seeding state from it would change the first
  // client paint and break hydration. It also only ever runs once, and only
  // while the field is untouched -- an explicit choice always wins.
  const countrySeededRef = useRef(false);
  useEffect(() => {
    if (countrySeededRef.current) return;
    if (currentPhoneNumber) return;
    if (localPhoneNumber) return;
    countrySeededRef.current = true;
    const region = resolveContactPhoneRegion({});
    if (!region || region === DEFAULT_COUNTRY_VALUE) return;
    if (!PHONE_COUNTRY_OPTIONS.some((option) => option.value === region)) return;
    setSelectedCountry(region);
  }, [currentPhoneNumber, localPhoneNumber]);

  useEffect(() => {
    onStepChange?.(step);
  }, [onStepChange, step]);

  const returnToPhoneNumber = useCallback(() => {
    if (!current()) return true;
    if (phoneFlowInFlightRef.current) return true;
    visit.smsTransport = false;
    if (conflict === "review" && !transferPending) { advanceEntryRevision(); setConflict("choices"); setOperationError(null); return true; }
    if (conflict === "delete") { if (deletion.leave()) { advanceEntryRevision(); setConflict("choices"); setOperationError(null); } return true; }
    if (transferPending) return true;
    advanceEntryRevision();
    setVerificationCode("");
    setCodeError(null);
    setOperationError(null);
    setConflict(null);
    changeStep("phone");
    return true;
  }, [current, changeStep, phoneFlowInFlightRef, advanceEntryRevision, conflict, transferPending, visit, deletion]);

  useEffect(() => {
    onBackStepChange?.(step === "code" ? returnToPhoneNumber : null);
    return () => onBackStepChange?.(null);
  }, [onBackStepChange, returnToPhoneNumber, step]);

  const maskedPhone = useMemo(
    // Same read-back as the Account row that opens this flow, so the number
    // does not change shape between the two screens.
    () => formatMaskedPhoneNumber(step === "linked" ? submittedPhoneNumber || currentPhoneNumber : currentPhoneNumber),
    [currentPhoneNumber, submittedPhoneNumber, step],
  );
  const selectedCountryOption = useMemo(
    () =>
      PHONE_COUNTRY_OPTIONS.find((option) => option.value === selectedCountry),
    [selectedCountry],
  );
  const selectedCountryLabel = useMemo(
    () =>
      getCountryOptionLabel(selectedCountryOption ?? DEFAULT_PHONE_COUNTRY_OPTION),
    [selectedCountryOption],
  );
  const countryInputValue = countryComboboxOpen
    ? countryQuery
    : selectedCountryLabel;
  const filteredCountryOptions = useMemo(() => {
    const normalizedQuery = countryQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return PHONE_COUNTRY_OPTIONS;
    }

    return PHONE_COUNTRY_OPTIONS.filter((option) => {
      const searchableText = [
        option.label,
        option.dialCode,
        option.value,
        getCountryOptionLabel(option),
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [countryQuery]);
  const activeDialCode = useMemo(
    () => selectedCountryOption?.dialCode ?? DEFAULT_PHONE_COUNTRY_OPTION.dialCode,
    [selectedCountryOption],
  );
  const selectedCountryDisplayLabel = useMemo(
    () =>
      `${activeDialCode} ${selectedCountryOption?.label ?? DEFAULT_PHONE_COUNTRY_OPTION.label}`,
    [activeDialCode, selectedCountryOption],
  );
  const normalizedPhoneInput = useMemo(
    () => composePhoneNumber(activeDialCode, localPhoneNumber),
    [activeDialCode, localPhoneNumber],
  );
  const mobileNumberLengthRange = useMemo(
    () => getMobileNumberLengthRange(selectedCountry),
    [selectedCountry],
  );

  const handleCountrySelection = useCallback((value: string | null) => {
    if (!current() || phoneFlowInFlightRef.current || !value) {
      return;
    }

    const nextOption = PHONE_COUNTRY_OPTIONS.find(
      (option) => option.value === value,
    );
    if (!nextOption) {
      return;
    }
    if (nextOption.value !== selectedCountry) advanceEntryRevision();

    setSelectedCountry(nextOption.value);
    const maximum = getMobileNumberLengthRange(nextOption.value).maximum;
    rejectedPhoneInputRef.current = localPhoneNumber.length > maximum;
    setPhoneNumberError((previous) => phonePresentation === "compact"
      ? (previous ? getPhoneEntryError(localPhoneNumber, nextOption.value) : null)
      : localPhoneNumber.length > maximum
        ? `Enter no more than ${maximum} digits for ${nextOption.label}.`
        : null);

    setCountryQuery("");
    setCountryComboboxOpen(false);
  }, [current, localPhoneNumber, selectedCountry, phonePresentation, phoneFlowInFlightRef, advanceEntryRevision]);

  useLocalOnboardingActionHandler("phone_mandate.select_country", (slots) => {
    if (!current()) return { status: "blocked", summary: "Phone verification is no longer open." };
    const requested = String(
      slots.country ?? slots.countryCode ?? slots.dialCode ?? "",
    )
      .trim()
      .toLowerCase();
    if (!requested) {
      return {
        status: "blocked",
        summary: "Which visible country or country code should I choose?",
      };
    }
    const matches = filteredCountryOptions.filter((option) =>
      [
        option.value,
        option.label,
        option.dialCode,
        getCountryOptionLabel(option),
      ]
        .map((value) => value.toLowerCase())
        .includes(requested),
    );
    if (matches.length !== 1) {
      return {
        status: "blocked",
        summary:
          matches.length > 1
            ? "That code matches more than one visible country. Which country do you mean?"
            : "That country is not visible in the current picker.",
      };
    }
    handleCountrySelection(matches[0]!.value);
    return {
      status: "succeeded",
      summary: `${matches[0]!.label} selected.`,
    };
  });

  useLocalOnboardingActionHandler("phone_mandate.close_country_picker", () => {
    if (!current()) return { status: "blocked", summary: "Phone verification is no longer open." };
    if (!countryComboboxOpen) {
      return {
        status: "blocked",
        summary: "The country picker is already closed.",
      };
    }
    setCountryComboboxOpen(false);
    setCountryQuery("");
    suppressNextCountryFocusOpenRef.current = true;
    requestAnimationFrame(() => {
      if (!current()) return;
      document.getElementById("phone-flow-country")?.focus();
      suppressNextCountryFocusOpenRef.current = false;
    });
    return { status: "succeeded", summary: "Country picker closed." };
  });

  usePublishVoiceSurfaceMetadata(
    conflict ? {
      screenId: pathname === ROUTES.PHONE_MANDATE ? "phone_mandate" : "profile_account",
      title: transferPending ? "Phone transfer pending" : "Phone recovery choices",
      purpose: "Choose how to recover a phone link without revealing the previous account.",
      actions: [], controls: [],
      interactionLayer: {
        schemaVersion: "voice_interaction_layer.v1", id: "phone_conflict", kind: "confirmation",
        modality: "modal", lifecycle: "open", dismissible: false,
        visibleActionIds: [], visibleControlIds: [], options: [], blocksUnderlyingActions: true,
        agentContinuity: "suppressed",
      },
    } : pathname === ROUTES.PHONE_MANDATE && countryComboboxOpen
      ? {
          screenId: "phone_mandate",
          title: "Choose country code",
          purpose:
            "Choose one of the bounded country-code options currently visible in the phone form.",
          actions: [
            {
              id: "phone_mandate.select_country",
              actionId: "phone_mandate.select_country",
              label: "Choose Country Code",
              purpose: "Choose one visible country option.",
            },
            {
              id: "phone_mandate.close_country_picker",
              actionId: "phone_mandate.close_country_picker",
              label: "Close Country Picker",
              purpose: "Close the picker and restore the country field.",
            },
          ],
          controls: [
            {
              id: "phone-flow-country",
              label: "Country code",
              type: "combobox",
              purpose: "Search or choose a country code.",
              actionId: "phone_mandate.select_country",
            },
          ],
          interactionLayer: {
            schemaVersion: "voice_interaction_layer.v1",
            id: "phone_country_picker",
            kind: "country_picker",
            modality: "nonmodal",
            lifecycle: "open",
            dismissible: true,
            dismissActionId: "phone_mandate.close_country_picker",
            visibleActionIds: [
              "phone_mandate.select_country",
              "phone_mandate.close_country_picker",
            ],
            visibleControlIds: ["phone-flow-country"],
            options: filteredCountryOptions.slice(0, 10).map((option) => ({
              id: option.value,
              label: getCountryOptionLabel(option),
              actionId: "phone_mandate.select_country",
            })),
            returnFocusControlId: "phone-flow-country",
            blocksUnderlyingActions: false,
            agentContinuity: "interactive",
          },
        }
      : null,
    { role: "interaction_layer", routeKey: pathname },
  );

  const handlePhoneNumberChange = useCallback((value: string, countryOverride?: string) => {
    if (!current() || phoneFlowInFlightRef.current) return false;
    const nextInput = resolvePhoneInputChange(value);
    if (countryOverride && !PHONE_COUNTRY_OPTIONS.some(option => option.value === countryOverride)) return false;
    // A complete international paste identifies its own recipient. Never
    // reinterpret it using the currently visible country's dialing prefix.
    const nextCountry = nextInput.countryValue ?? countryOverride ?? selectedCountry;
    const nextOption = getCountryOption(nextCountry);
    const maximum = getMobileNumberLengthRange(nextCountry).maximum;
    if (nextInput.localPhoneNumber.length > maximum) {
      // Reject instead of truncating into a different recipient.
      rejectedPhoneInputRef.current = true;
      advanceEntryRevision();
      setPhoneNumberError((previous) => phonePresentation === "compact"
        ? (previous ? "Enter a valid phone number." : null)
        : `Enter no more than ${maximum} digits for ${nextOption.label}.`);

      return false;
    }
    if (nextInput.localPhoneNumber !== localPhoneNumber || nextCountry !== selectedCountry || rejectedPhoneInputRef.current) advanceEntryRevision();
    if (countryOverride || nextInput.countryValue) {
      setSelectedCountry(nextOption.value);
      setCountryQuery("");
    }
    rejectedPhoneInputRef.current = false;
    setLocalPhoneNumber(nextInput.localPhoneNumber);
    setPhoneNumberError((previous) => phonePresentation === "compact" && previous
      ? getPhoneEntryError(nextInput.localPhoneNumber, nextCountry) : null);
    return true;
  }, [current, selectedCountry, localPhoneNumber, phonePresentation, phoneFlowInFlightRef, advanceEntryRevision]);

  const handlePhoneNumberPaste = useCallback(
    (event: React.ClipboardEvent<HTMLInputElement>) => {
      const pastedValue = event.clipboardData.getData("text");
      const selectionStart = event.currentTarget.selectionStart ?? 0;
      const selectionEnd =
        event.currentTarget.selectionEnd ?? localPhoneNumber.length;
      const nextValue = `${localPhoneNumber.slice(0, selectionStart)}${pastedValue}${localPhoneNumber.slice(selectionEnd)}`;
      // Intercept before maxLength can clip a complete international paste.
      event.preventDefault();
      handlePhoneNumberChange(nextValue);
    },
    [handlePhoneNumberChange, localPhoneNumber],
  );

  const handleStartVerification = useCallback(
    async (
      resendCode = false,
      phoneNumberOverride?: string,
      transport?: "sms",
    ): Promise<StartVerificationOutcome> => {
      const freshSms = transport === "sms" && conflict === "choices" && !transferEligible;
      if (!current() || allowedOperation.current?.() === false || entryRevision !== visit.entryRevision || (conflict !== null && !freshSms) || busy || phoneFlowInFlightRef.current ||
          (!freshSms && (resendCode ? stepRef.current !== "code" : stepRef.current !== "phone"))) {
        return "busy";
      }
      const normalizedPhone = (
        phoneNumberOverride ?? normalizedPhoneInput
      ).trim();
      const validationCountry = phoneNumberOverride
        ? derivePhoneFields(normalizedPhone).countryValue
        : selectedCountry;
      if (phonePresentation !== "compact" && !phoneNumberOverride && phoneNumberError) {
        morphyToast.error(phoneNumberError);
        return "invalid";
      }
      let validationError = getPhoneNumberValidationError(normalizedPhone, validationCountry);
      if (phonePresentation === "compact") {
        validationError = validationError ? "Enter a valid phone number." : null;
        if (!phoneNumberOverride && !localPhoneNumber) {
          validationError = "Enter your phone number.";
        }
        if (!phoneNumberOverride && rejectedPhoneInputRef.current) {
          validationError = "Enter a valid phone number.";
        }
      }
      if (validationError) {
        setPhoneNumberError(validationError);
        if (phonePresentation !== "compact") morphyToast.error(validationError);
        return "invalid";
      }
      rejectedPhoneInputRef.current = false;
      setPhoneNumberError(null);

      if (!freshSms && currentPhoneNumber && normalizedPhone === currentPhoneNumber && !Capacitor.isNativePlatform()) {
        trackEvent("phone_verification_completed", {
          action: "existing",
          result: "success",
        });
        morphyToast.success(
          "This phone number is already linked to your account.",
        );
        if (current()) await onCompleted();
        return "already_linked";
      }

      phoneFlowInFlightRef.current = true;
      setBusy(true);
      setOperationError(null);
      let committed = false;
      try {
        if (!resendCode) visit.smsTransport = freshSms;
        const result = await startVerification(normalizedPhone, { resendCode, ...(visit.smsTransport ? { transport: "sms" as const } : {}) });
        if (!current()) return "busy";
        setConflict(null);
        trackEvent("phone_verification_started", {
          action: mode,
          result: "success",
        });
        if (result.autoVerified) {
          committed = true;
          visit.verified = true; visit.verifiedUser = result.user;
          setSubmittedPhoneNumber(normalizedPhone); changeStep("linked");
          trackEvent("phone_verification_completed", {
            action: mode,
            result: "success",
          });
          morphyToast.success(
            mode === "replace"
              ? "Phone number updated."
              : "Phone number verified.",
          );
          await onCompleted(result.user ?? undefined);
          return "auto_verified";
        }

        setSubmittedPhoneNumber(normalizedPhone);
        // A resend replaces the verification session outright (auth-context
        // already discards the previous verificationId before starting this
        // one). Any digits the user typed against the OLD code are stale the
        // instant a new one exists -- keeping them invites confirming the
        // wrong session.
        setVerificationCode("");
        setCodeError(null);
        changeStep("code");
        morphyToast.success(
          resendCode
            ? "A new verification code has been sent."
            : "Verification code sent.",
        );
        return "code_sent";
      } catch (error) {
        if (!current()) return "busy";
        const message = committed ? "Phone verified. Couldn’t refresh Account. You can return to Account." :
          phoneFailureMessage(error, "Couldn't send the verification code. Please try again.");
        setOperationError(message);
        if (["PHONE_TEST_NUMBER_IN_USE", "PHONE_ALREADY_VERIFIED", "PHONE_TRANSFER_CONFIRMATION_REQUIRED", "PHONE_SESSION_ACCOUNT_CONFLICT"].includes(apiErrorCode(error) ?? "")) {
          advanceEntryRevision(); setSubmittedPhoneNumber(normalizedPhone); setTransferEligible(false); setConflict("choices"); changeStep("code");
        }
        if (committed) { morphyToast.error(message); return "auto_verified"; }
        trackEvent("phone_verification_started", {
          action: mode,
          result: "error",
        });
        morphyToast.error(message);
        return "failed";
      } finally {
        phoneFlowInFlightRef.current = false;
        if (current()) setBusy(false);
      }
    },
    [
      currentPhoneNumber,
      mode,
      normalizedPhoneInput,
      onCompleted,
      phoneNumberError,
      phonePresentation,
      localPhoneNumber,
      selectedCountry,
      startVerification,
      busy,
      current,
      changeStep,
      phoneFlowInFlightRef,
      visit,
      entryRevision,
      conflict,
      transferEligible,
      advanceEntryRevision,
    ],
  );

  const handleContinueExisting = useCallback(async () => {
    if (!current() || allowedOperation.current?.() === false || busy || phoneFlowInFlightRef.current) return;
    phoneFlowInFlightRef.current = true;
    setBusy(true);
    setOperationError(null);
    try {
      if (visit.verified) { await onCompleted(visit.verifiedUser); return; }
      if (!Capacitor.isNativePlatform()) {
        if (onContinueExisting) await onContinueExisting(); else await onCompleted();
        return;
      }
      if (!currentPhoneNumber) return;
      const result = await startVerification(currentPhoneNumber);
      if (!current()) return;
      if (!result.autoVerified) throw new Error("Phone verification could not be synchronized. Please retry.");
      visit.verified = true; visit.verifiedUser = result.user;
      if (onContinueExisting) await onContinueExisting(); else await onCompleted(result.user);
    } catch (error) {
      if (!current()) return;
      const message = phoneFailureMessage(error, "Phone verification could not be synchronized. Please retry.");
      setOperationError(message); morphyToast.error(message);
    } finally {
      phoneFlowInFlightRef.current = false;
      if (current()) setBusy(false);
    }
  }, [busy, current, currentPhoneNumber, onContinueExisting, onCompleted, startVerification, phoneFlowInFlightRef, visit]);

  // Voice parity: "my phone number is +1 555 010 1234" fills the same fields
  // a typed entry would, then runs the exact same start-verification flow as
  // tapping the Send code button. The phone number is passed directly to
  // `handleStartVerification` (not read back from `normalizedPhoneInput`)
  // because the field-state updates below are async and would not be visible
  // yet on this same tick. The confirmation-code action uses the same
  // verification operation as the typed form, but only after the voice
  // surface receives an explicit inline confirmation. Its sensitive slot is
  // kept transient and is never rendered or repeated in the settlement.
  useLocalOnboardingActionHandler(
    "phone_mandate.submit_number",
    async (slots) => {
      if (!current()) return { status: "blocked", summary: "Phone verification is no longer open." };
      const rawPhoneNumber = String(slots.phoneNumber ?? "").trim();
      if (!rawPhoneNumber) {
        return {
          status: "blocked",
          summary: "What's your phone number, including country code?",
        };
      }
      const candidate = rawPhoneNumber.startsWith("+")
        ? rawPhoneNumber
        : `+${rawPhoneNumber}`;
      if (!E164_PHONE_PATTERN.test(candidate)) {
        return {
          status: "blocked",
          summary:
            "That doesn't look like a valid phone number with country code.",
        };
      }
      const fields = derivePhoneFields(candidate);
      setSelectedCountry(fields.countryValue);
      setLocalPhoneNumber(fields.localPhoneNumber);
      const outcome = await handleStartVerification(false, candidate);
      if (outcome === "failed") {
        return {
          status: "failed",
          summary: "The verification code could not be sent.",
        };
      }
      if (outcome === "invalid") {
        return {
          status: "blocked",
          summary: "That phone number could not be verified.",
        };
      }
      if (outcome === "busy") {
        return {
          status: "blocked",
          summary: "The phone verification is already in progress.",
        };
      }
      return {
        status: "succeeded",
        summary:
          outcome === "code_sent"
            ? "Verification code sent."
            : "Phone verified.",
      };
    },
  );

  const submitVerificationCode = useCallback(
    async (
      code: string,
      options: { notify: boolean },
    ): Promise<ConfirmVerificationOutcome> => {
      const normalizedCode = code.replace(/\D/g, "").slice(0, 6);
      if (normalizedCode.length !== 6) {
        if (options.notify) {
          morphyToast.error("Enter the six-digit verification code you received.");
        }
        return "invalid";
      }
      if (!current() || allowedOperation.current?.() === false || entryRevision !== visit.entryRevision || conflict !== null || busy || phoneFlowInFlightRef.current || stepRef.current !== "code") {
        return "busy";
      }

      phoneFlowInFlightRef.current = true;
      setBusy(true);
      let committed = false;
      try {
        setCodeError(null);
        setOperationError(null);
        const verifiedUser = await confirmVerification(normalizedCode);
        if (!current()) return "busy";
        committed = true;
        visit.verified = true; visit.verifiedUser = verifiedUser;
        setVerificationCode(""); changeStep("linked");
        trackEvent("phone_verification_completed", {
          action: mode,
          result: "success",
        });
        await onCompleted(verifiedUser);
        if (current() && options.notify) {
          morphyToast.success(
            mode === "replace" ? "Phone number updated." : "Phone number verified.",
          );
        }
        return "verified";
      } catch (error) {
        if (!current()) return "busy";
        const message = committed ? "Phone verified. Couldn’t refresh Account. You can return to Account." :
          phoneFailureMessage(error, "Couldn't verify the phone number. Please try again.");
        setOperationError(message);
        if (committed) { if (options.notify) morphyToast.error(message); return "verified"; }
        if (["PHONE_TRANSFER_CONFIRMATION_REQUIRED", "PHONE_SESSION_ACCOUNT_CONFLICT", "PHONE_ALREADY_VERIFIED", "PHONE_TEST_NUMBER_IN_USE"].includes(apiErrorCode(error) ?? "")) {
          advanceEntryRevision(); setTransferEligible(apiErrorCode(error) !== "PHONE_TEST_NUMBER_IN_USE"); setVerificationCode(""); setConflict("choices");
        }
        trackEvent("phone_verification_completed", {
          action: mode,
          result: "error",
        });
        // The link only fails on the code step, so this is where the conflict
        // usually surfaces.
        // An expired code can never succeed by resubmitting the same digits,
        // so clear the input and leave the person on the OTP screen with
        // Resend available. A wrong code stays in place -- it may be a typo
        // worth fixing, not a dead session -- and no SMS is auto-sent either
        // way; Resend remains an explicit tap.
        const errorCode = String((error as { code?: unknown })?.code ?? apiErrorCode(error) ?? "");
        if (
          codePresentation === "onboarding" &&
          ["invalid-verification-code", "auth/invalid-verification-code", "UAT_PHONE_TEST_INVALID_CODE"].includes(errorCode)
        ) {
          setCodeError("That code isn't right. Check it and try again.");
        }
        if (errorCode === "code-expired") {
          setVerificationCode("");
        }
        if (options.notify) {
          morphyToast.error(message);
        }
        return "failed";
      } finally {
        phoneFlowInFlightRef.current = false;
        if (current()) setBusy(false);
      }
    },
    [busy, current, codePresentation, confirmVerification, mode, onCompleted, changeStep, phoneFlowInFlightRef, visit, entryRevision, conflict, advanceEntryRevision],
  );

  const handleConfirmVerification = useCallback(async () => {
    await submitVerificationCode(verificationCode, { notify: true });
  }, [submitVerificationCode, verificationCode]);

  const handleTransfer = useCallback(async () => {
    if (!current() || allowedOperation.current?.() === false || busy || phoneFlowInFlightRef.current || conflict !== "review" || visit.entryRevision !== entryRevision || !transferEligible || !confirmTransfer) return;
    phoneFlowInFlightRef.current = true; setBusy(true); setOperationError(null);
    let committed = false;
    try {
      const verified = await confirmTransfer();
      if (!current()) return;
      committed = true; visit.verified = true; visit.verifiedUser = verified;
      setConflict(null); setTransferPending(false); transferGuard.pending = false; changeStep("linked");
      await onCompleted(verified);
    } catch (error) {
      if (current() && !committed) {
        const actionRequired = apiErrorCode(error) === "PHONE_TRANSFER_ACTION_REQUIRED";
        const pending = actionRequired || apiErrorCode(error) === "PHONE_TRANSFER_IN_PROGRESS";
        transferGuard.pending = pending; setTransferPending(pending);
        setOperationError(actionRequired ? "Phone transfer needs a security check. Contact one@hushh.ai and check progress again." : pending ? "Finishing phone transfer. Check progress again." :
          phoneFailureMessage(error, error instanceof Error ? error.message : "Phone transfer could not be confirmed. Please retry."));
      }
    } finally { phoneFlowInFlightRef.current = false; if (current()) setBusy(false); }
  }, [busy, conflict, confirmTransfer, current, changeStep, onCompleted, visit, entryRevision, transferEligible, phoneFlowInFlightRef, transferGuard]);

  const recoverPrevious = useCallback(async (deleting: boolean | "revoke") => {
    if (!current() || conflict !== "choices" || visit.entryRevision !== entryRevision || busy || phoneFlowInFlightRef.current || transferPending) return;
    const recover = deleting === "revoke" ? revokePreviousAccountDevices : deleting ? deletePreviousAccount : recoverPreviousAccount;
    await performPhoneRecovery(recover, submittedPhoneNumber, current, phoneFlowInFlightRef, setBusy, setOperationError);
  }, [current, busy, transferPending, revokePreviousAccountDevices, deletePreviousAccount, recoverPreviousAccount, phoneFlowInFlightRef, conflict, visit, entryRevision, submittedPhoneNumber]);

  useLocalOnboardingActionHandler(
    "phone_mandate.submit_code",
    async (slots) => {
      const code = String(slots.code ?? slots.verificationCode ?? "")
        .replace(/\D/g, "")
        .slice(0, 6);
      if (step !== "code") {
        return {
          status: "blocked",
          summary: "Send a verification code first.",
        };
      }
      if (code.length !== 6) {
        return {
          status: "blocked",
          summary: "Please provide the six-digit verification code.",
        };
      }
      const outcome = await submitVerificationCode(code, { notify: false });
      if (outcome === "verified") {
        return {
          status: "succeeded",
          summary: "Phone verified. Continuing setup.",
        };
      }
      if (outcome === "busy") {
        return {
          status: "blocked",
          summary: "The code is already being verified.",
        };
      }
      if (outcome === "invalid") {
        return {
          status: "blocked",
          summary: "Please provide the six-digit verification code.",
        };
      }
      return {
        status: "failed",
        summary: "That code could not be verified.",
      };
    },
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // Enter is used to choose a country while the authored combobox is open;
      // it must not also send an SMS.
      if (countryComboboxOpen) return;
      if (step === "phone") {
        void handleStartVerification(false);
        return;
      }
      if (step === "code") {
        void handleConfirmVerification();
      }
    },
    [
      countryComboboxOpen,
      handleConfirmVerification,
      handleStartVerification,
      step,
    ],
  );

  return { ready: formOwner === ownerKey, step, busy, maskedPhone, submittedPhoneNumber, verificationCode, codeError, phoneNumberError, operationError,
    conflict, transferPending, transferEligible, handleTransfer, recoverPrevious,
    deletionReview: deletion.prepared, deletionNeedsFreshProof: deletion.freshProof, deletionUnconfirmed: deletion.unconfirmed,
    deletePrevious: deletion.review, confirmDeletion: deletion.submit,
    restartVerification: () => { if (current() && !phoneFlowInFlightRef.current && deletion.leave()) { advanceEntryRevision(); setVerificationCode(""); setOperationError(null); setConflict(null); changeStep("phone"); } },
    startFreshSms: () => handleStartVerification(false, submittedPhoneNumber, "sms"),
    reviewTransfer: () => { if (current() && visit.entryRevision === entryRevision && conflict === "choices" && transferEligible && !busy && !phoneFlowInFlightRef.current) { advanceEntryRevision(); setConflict("review"); setOperationError(null); } },
    countries: PHONE_COUNTRY_OPTIONS,
    selectedCountry, selectedCountryOption, selectedCountryDisplayLabel, countryQuery, countryInputValue, countryComboboxOpen,
    filteredCountryOptions, localPhoneNumber, mobileNumberLengthRange, suppressNextCountryFocusOpenRef,
    setCountryComboboxOpen, setCountryQuery, handleCountrySelection, handlePhoneNumberChange, handlePhoneNumberPaste,
    handleStartVerification, handleContinueExisting, handleConfirmVerification, submitVerificationCode,
    returnToPhoneNumber, handleSubmit, current,
    changeCode: (value: string) => {
      if (!current() || phoneFlowInFlightRef.current || stepRef.current !== "code") return;
      const next = value.replace(/\D/g, "").slice(0, 6);
      if (next !== verificationCode) advanceEntryRevision();
      setCodeError(null); setVerificationCode(next);
    },
  };
}

export type PhoneVerificationModel = ReturnType<typeof usePhoneVerificationFlow>;

export function PhoneVerificationFlow(props: PhoneVerificationFlowProps) {
  const model = usePhoneVerificationFlow(props);
  return <PhoneVerificationForm {...props} model={model} />;
}

export function PhoneVerificationForm({ model, className, style, onCancel, codePresentation = "default", phonePresentation = "default",
  helperText, primaryActionClassName, sendCodeLabel, confirmLabel, submissionBlocked = false }: PhoneVerificationFlowProps & {
    model: PhoneVerificationModel; submissionBlocked?: boolean;
  }) {
  const { step, busy, maskedPhone, submittedPhoneNumber, verificationCode, codeError, phoneNumberError,
    selectedCountry, selectedCountryOption, selectedCountryDisplayLabel, countryQuery, countryInputValue, countryComboboxOpen,
    filteredCountryOptions, localPhoneNumber, mobileNumberLengthRange, suppressNextCountryFocusOpenRef,
    setCountryComboboxOpen, setCountryQuery, handleCountrySelection, handlePhoneNumberChange, handlePhoneNumberPaste,
    handleStartVerification, handleContinueExisting, returnToPhoneNumber, handleSubmit, changeCode } = model;
  if (model.conflict) return <PhoneConflictRecovery {...model} conflict={model.conflict}
    className={className} style={style} submissionBlocked={submissionBlocked} />;
  if (step === "linked") {
    return (
      <div className={className} style={style}>
        <div
          className={`${FLOW_SURFACE_RADIUS_CLASS_NAME} border border-[rgba(18,161,80,0.35)] bg-[rgba(18,161,80,0.08)] p-5 dark:bg-[rgba(18,161,80,0.16)]`}
        >
          <ShieldCheck className="h-10 w-10 text-[#12A150] dark:text-[#3FBF77]" />
          <h2 className={cn(kaiAppCardTitleClassName, "mt-4 text-foreground")}>
            Phone already linked
          </h2>
          <p
            className={cn(kaiAppHelperClassName, "mt-2 text-muted-foreground")}
          >
            This account already has a verified phone number:{" "}
            {maskedPhone || "already on this account"}.
          </p>
        </div>
        <Button
          onClick={() => void handleContinueExisting()}
          disabled={busy || submissionBlocked}
          variant="none"
          effect="fill"
          size="default"
          fullWidth
          className={cn(
            "type-headline mt-6",
            FLOW_CTA_CLASS_NAME,
            primaryActionClassName,
          )}
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <form
      className={className}
      style={style}
      noValidate
      onSubmit={event => { if (submissionBlocked) event.preventDefault(); else handleSubmit(event); }}
      data-figma-phone-flow="true"
      data-figma-phone-step={step}
      data-phone-presentation={phonePresentation}
    >
      <FieldSet>
      {step === "phone" ? (
        <>
          <FieldGroup className="gap-5" data-figma-phone-fields="true">
            <Field className="gap-2" data-figma-phone-field="country">
              <FieldLabel
                className="text-[13px] font-semibold text-[#8a8a91] dark:text-white/50"
                htmlFor="phone-flow-country"
              >
                Country code
              </FieldLabel>
              {phonePresentation === "compact" ? (
                <CountryPicker
                  inline
                  open={countryComboboxOpen}
                  onOpenChange={(open) => {
                    setCountryComboboxOpen(open);
                    if (open) setCountryQuery("");
                  }}
                  query={countryQuery}
                  onQueryChange={setCountryQuery}
                  options={filteredCountryOptions}
                  selected={selectedCountryOption ?? DEFAULT_PHONE_COUNTRY_OPTION}
                  onSelect={handleCountrySelection}
                />
              ) : (
              <Combobox
                open={countryComboboxOpen}
                onOpenChange={(open) => {
                  setCountryComboboxOpen(open);
                  // Base UI owns keyboard/input events at the root. Reset the
                  // query only while opening so the selected country restores
                  // after a close, rather than competing with the nested
                  // input's own value on mobile WebViews.
                  if (open) {
                    setCountryQuery("");
                  }
                }}
                value={selectedCountry}
                onValueChange={handleCountrySelection}
                inputValue={countryInputValue}
                onInputValueChange={(value, eventDetails) => {
                  // Selecting an item causes Base UI to report its internal
                  // value (for example "IN"). That is not a search edit, and
                  // accepting it would overwrite the selected display label
                  // or leave the list filtered to an opaque country code.
                  if (
                    eventDetails.reason !== "input-change" &&
                    eventDetails.reason !== "input-clear"
                  ) {
                    return;
                  }
                  setCountryQuery(value);
                  if (!countryComboboxOpen) {
                    setCountryComboboxOpen(true);
                  }
                }}
                items={filteredCountryOptions}
                // Country filtering is intentionally owned by
                // `filteredCountryOptions`: it matches country name, ISO code,
                // and dialing prefix. Base UI's default only sees the item
                // value, so it cannot find "+33" from a "FR" value.
                filter={null}
              >
                <ComboboxInput
                  id="phone-flow-country"
                  data-voice-control-id="phone-flow-country"
                  placeholder="Search country code"
                  onFocus={(event: React.FocusEvent<HTMLInputElement>) => {
                    if (suppressNextCountryFocusOpenRef.current) {
                      suppressNextCountryFocusOpenRef.current = false;
                      return;
                    }
                    setCountryComboboxOpen(true);
                    setCountryQuery("");
                    event.currentTarget.select();
                  }}
                  className={cn(
                    FLOW_CONTROL_SHELL_CLASS_NAME,
                    "relative w-full",
                    !countryComboboxOpen &&
                      "[&_input]:min-w-0 [&_input]:truncate [&_input]:whitespace-nowrap [&_input]:!text-transparent [&_input]:!caret-transparent",
                  )}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  showTrigger
                >
                  {!countryComboboxOpen ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 left-4 z-10 flex min-w-0 max-w-[calc(100%-3.5rem)] items-center gap-2 whitespace-nowrap text-[15px] text-[#17130c] dark:text-[#f5f5f7]"
                    >
                      <FigmaCountryFlag
                        countryCode={
                          selectedCountryOption?.value ??
                          DEFAULT_PHONE_COUNTRY_OPTION.value
                        }
                      />
                      <span className="min-w-0 truncate">
                        {selectedCountryDisplayLabel}
                      </span>
                    </span>
                  ) : null}
                </ComboboxInput>
                <ComboboxContent
                  className={`w-[var(--anchor-width)] ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
                >
                  <ComboboxList>
                    <ComboboxEmpty>No country codes found.</ComboboxEmpty>
                    <ComboboxGroup>
                      <ComboboxCollection>
                        {(item: CountryPhoneOption) => (
                          <ComboboxItem
                            key={item.value}
                            value={item.value}
                            className="cursor-pointer"
                            onClick={() => handleCountrySelection(item.value)}
                          >
                            <div className="flex w-full items-center justify-between gap-3">
                              <span className="truncate">{item.label}</span>
                              <span className="shrink-0 text-current">
                                {item.dialCode}
                              </span>
                            </div>
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              )}
            </Field>

            <Field className="gap-2" data-figma-phone-field="number" data-invalid={Boolean(phoneNumberError)}>
              <FieldLabel
                className="text-[13px] font-semibold text-[#8a8a91] dark:text-white/50"
                htmlFor="phone-flow-number"
              >
                Phone number
              </FieldLabel>
              <InputGroup className={FLOW_CONTROL_SHELL_CLASS_NAME}>
                <InputGroupInput
                  id="phone-flow-number"
                  data-voice-control-id="phone-flow-number"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  maxLength={mobileNumberLengthRange.maximum}
                  value={localPhoneNumber}
                  aria-invalid={Boolean(phoneNumberError)}
                  aria-describedby={
                    phoneNumberError ? "phone-flow-number-error" : undefined
                  }
                  onChange={(event) =>
                    handlePhoneNumberChange(event.target.value)
                  }
                  onPaste={handlePhoneNumberPaste}
                  placeholder="Phone number"
                  className={FLOW_CONTROL_CLASS_NAME}
                />
              </InputGroup>
              {phoneNumberError ? (
                <FieldError id="phone-flow-number-error">
                  {phoneNumberError}
                </FieldError>
              ) : null}
            </Field>
          </FieldGroup>

          {phonePresentation === "compact" && countryComboboxOpen ? (
            <InlineCountryPickerPanel
              query={countryQuery}
              onQueryChange={setCountryQuery}
              options={filteredCountryOptions}
              selected={selectedCountryOption ?? DEFAULT_PHONE_COUNTRY_OPTION}
              onSelect={handleCountrySelection}
              onClose={() => setCountryComboboxOpen(false)}
            />
          ) : null}

          <FieldDescription
            className="type-callout text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]"
            data-figma-phone-helper="true"
          >
            {helperText ??
              "Choose your country code and enter your phone number. We’ll send you a verification code."}
          </FieldDescription>
          <div className="grid gap-3">
            <Button
              type="submit"
              data-figma-phone-primary="true"
              loading={busy}
              disabled={submissionBlocked}
              variant={phonePresentation === "compact" ? "blue" : "none"}
              effect="fill"
              size={phonePresentation === "compact" ? "prominent" : "default"}
              fullWidth
              className={phonePresentation === "compact" ? primaryActionClassName : cn(
                "type-headline",
                FLOW_CTA_CLASS_NAME,
                primaryActionClassName,
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                sendCodeLabel || "Send verification code"
              )}
            </Button>
            {onCancel ? (
              <Button
                type="button"
                onClick={onCancel}
                variant="none"
                effect="fade"
                fullWidth
                disabled={busy}
                className={`type-subhead h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p
            className="text-center text-sm leading-6 text-muted-foreground"
            data-figma-otp-intro="true"
          >
            Enter the code sent to{" "}
            <span className="whitespace-nowrap font-semibold text-foreground">
              {maskPhoneNumberForOtp(submittedPhoneNumber)}
            </span>
            .{" "}
            {codePresentation === "onboarding" && (
              <button type="button" onClick={() => void handleStartVerification(true)} disabled={busy || submissionBlocked} className="text-[color:var(--app-accent-deep)] disabled:opacity-50">
                Resend code
              </button>
            )}
          </p>

          <Field className="gap-2" data-figma-otp-field="true" data-invalid={Boolean(codeError)}>
            <FieldLabel htmlFor="phone-flow-code">One-time code</FieldLabel>
            <div className="relative">
              <div className="flex gap-2" data-otp-cells="true">
                {Array.from({ length: 6 }).map((_, index) => {
                  const active = index === Math.min(verificationCode.length, 5);
                  const filled = index < verificationCode.length;
                  return (
                    <div
                      key={index}
                      data-current={active}
                      className={cn(
                        "flex h-[60px] flex-1 items-center justify-center rounded-[var(--app-radius-lg)] border text-[22px] font-bold text-[#0A0A0A] transition-colors dark:text-white",
                        active
                          ? "border-[color:var(--app-accent)] bg-white shadow-[0_0_0_4px_var(--app-accent-ring)] dark:bg-white/[0.06]"
                          : "border-black/10 bg-black/[0.02] dark:border-white/15 dark:bg-white/[0.04]",
                      )}
                    >
                      {filled ? (
                        verificationCode[index]
                      ) : active ? (
                        <span className="h-6 w-px animate-pulse bg-[color:var(--app-accent)]" />
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <input
                id="phone-flow-code"
                data-voice-control-id="phone-flow-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={6}
                aria-label="One-time code"
                aria-invalid={Boolean(codeError)}
                aria-describedby={codeError ? "phone-flow-code-error" : undefined}
                value={verificationCode}
                onChange={(event) => {
                  changeCode(event.target.value);
                }}
                autoFocus
                enterKeyHint="done"
                className="absolute inset-0 h-full w-full cursor-default rounded-2xl opacity-0 outline-none"
              />
            </div>
            {codeError && (
              <p
                id="phone-flow-code-error"
                role="alert"
                className="text-center text-sm font-semibold text-destructive"
              >
                {codeError}
              </p>
            )}
          </Field>

          <Button
            type="submit"
            data-figma-otp-primary="true"
            loading={busy}
            disabled={busy || submissionBlocked || verificationCode.length !== 6}
            variant={codePresentation === "onboarding" ? "blue" : "none"}
            effect="fill"
            size={codePresentation === "onboarding" ? "prominent" : "default"}
              fullWidth
            className={codePresentation === "onboarding" ? cn(primaryActionClassName, "disabled:!opacity-100") : cn(
              "type-headline",
              FLOW_CTA_CLASS_NAME,
              primaryActionClassName,
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              confirmLabel || "Verify and continue"
            )}
          </Button>

          <div data-figma-otp-actions="true" className="flex items-center justify-center gap-3 pt-1 text-[15px]">
            {codePresentation !== "onboarding" && <>
            <button
              type="button"
              onClick={() => void handleStartVerification(true)}
              disabled={busy || submissionBlocked}
              className="font-bold text-[color:var(--app-accent-deep)] transition-colors hover:text-[color:var(--app-accent-deep)] disabled:opacity-50 dark:text-[color:var(--app-accent-deep)]"
            >
              Resend code
            </button>
            <span aria-hidden className="text-black/25 dark:text-white/30">
              ·
            </span>
            </>}
            <button
              type="button"
              onClick={returnToPhoneNumber}
              disabled={busy}
              className="font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {codePresentation === "onboarding" ? "Use a Different number" : "Use a different number"}
            </button>
          </div>
        </>
      )}
      </FieldSet>
    </form>
  );
}
