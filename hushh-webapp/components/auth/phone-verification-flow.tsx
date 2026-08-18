"use client";

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "firebase/auth";
import {
  getCountryCallingCode,
  isSupportedCountry,
  Metadata,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/core";
import mobilePhoneMetadata from "libphonenumber-js/mobile/metadata";
import { Loader2, ShieldCheck } from "lucide-react";
import { usePathname } from "next/navigation";

import {
  Field,
  FieldDescription,
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
import {
  COUNTRY_PHONE_OPTIONS,
  type CountryPhoneOption,
} from "@/lib/constants/country-phone-options";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { formatMaskedPhoneNumber } from "@/lib/services/phone-display";
import { trackEvent } from "@/lib/observability/client";
import {
  kaiAppCardTitleClassName,
  kaiAppHelperClassName,
} from "@/components/kai/shared/kai-typography";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

/**
 * Firebase reports a number that is verified on a *different* account with one
 * of these. It is the case where somebody made an account earlier, forgot it,
 * and is now blocked on a number they own — so the server mails them the
 * masked address of the account that holds it.
 */
const PHONE_TAKEN_ERROR_CODES = new Set([
  "credential-already-in-use",
  "phone-number-already-exists",
]);

function isPhoneTakenByAnotherAccount(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "").replace(
    /^auth\//,
    "",
  );
  return PHONE_TAKEN_ERROR_CODES.has(code);
}

// Country metadata owns national-number length and validity.
const E164_PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;
const E164_MAX_DIGITS = 15;
const DEFAULT_COUNTRY_VALUE = "US";
const FLOW_CONTROL_SHELL_CLASS_NAME =
  "h-[54px] overflow-hidden rounded-[15px] border-black/10 bg-[#f5f5f7]/92 shadow-xs transition-[border-color,box-shadow] focus-within:border-[color:var(--app-accent)] focus-within:ring-4 focus-within:ring-[color:var(--app-accent-ring)] dark:border-white/10 dark:bg-white/[0.08]";
const FLOW_CONTROL_CLASS_NAME =
  "type-callout h-full rounded-[inherit] border-0 bg-transparent px-4 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent";
const FLOW_SURFACE_RADIUS_CLASS_NAME = "rounded-[18px]";
// Theme-aware flat accent pill CTA (follows the accent preference: iOS Blue
// default, Molten Gold opt-in). No gradient, no decorative shadow.
const FLOW_CTA_CLASS_NAME =
  "h-[54px] rounded-full border-0 !bg-[var(--app-accent)] !text-[var(--app-accent-fg)] transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:!bg-[var(--app-accent-hover)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100";

export type PhoneVerificationFlowMode = "link" | "replace";

type PhoneVerificationFlowProps = {
  mode: PhoneVerificationFlowMode;
  currentPhoneNumber?: string | null;
  startVerification: (
    phoneNumber: string,
    options?: { resendCode?: boolean },
  ) => Promise<{ autoVerified: boolean; user?: User | null }>;
  confirmVerification: (otp: string) => Promise<User>;
  onCompleted: (user?: User | null) => Promise<void> | void;
  onContinueExisting?: () => Promise<void> | void;
  onCancel?: () => void;
  confirmLabel?: string;
  className?: string;
  helperText?: string;
  style?: CSSProperties;
  onStepChange?: (step: VerificationStep) => void;
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

// Offer metadata-backed plans and keep NANP area codes in the national number.
const PHONE_COUNTRY_OPTIONS: readonly CountryPhoneOption[] =
  COUNTRY_PHONE_OPTIONS.filter((option) =>
    isSupportedCountry(option.value as CountryCode, mobilePhoneMetadata),
  ).map((option) => ({
    ...option,
    dialCode: `+${getCountryCallingCode(
      option.value as CountryCode,
      mobilePhoneMetadata,
    )}`,
  }));
const DEFAULT_PHONE_COUNTRY_OPTION =
  PHONE_COUNTRY_OPTIONS.find(
    (option) => option.value === DEFAULT_COUNTRY_VALUE,
  ) ?? PHONE_COUNTRY_OPTIONS[0]!;

function getCountryOptionLabel(option: {
  label: string;
  dialCode: string;
}): string {
  return `${option.label} (${option.dialCode})`;
}

function getCountryOption(value: string): CountryPhoneOption {
  return (
    PHONE_COUNTRY_OPTIONS.find((option) => option.value === value) ??
    DEFAULT_PHONE_COUNTRY_OPTION
  );
}

function getCountryOptionForPhoneNumber(
  phoneNumber: string,
): CountryPhoneOption | undefined {
  const matchingOptions = PHONE_COUNTRY_OPTIONS.filter((option) =>
    phoneNumber.startsWith(option.dialCode),
  ).sort((left, right) => right.dialCode.length - left.dialCode.length);
  const firstMatch = matchingOptions[0];
  if (!firstMatch) {
    return undefined;
  }

  const longestDialCodeLength = firstMatch.dialCode.length;
  const longestMatches = matchingOptions.filter(
    (option) => option.dialCode.length === longestDialCodeLength,
  );
  return (
    longestMatches.find((option) => option.value === DEFAULT_COUNTRY_VALUE) ??
    firstMatch
  );
}

function sanitizeDialCode(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits ? `+${digits}` : "";
}

function sanitizeLocalPhoneNumber(value: string): string {
  return value.replace(/\D/g, "");
}

type MobileNumberTypeMetadata = {
  possibleLengths: () => number[];
};

type MobileAwareMetadata = Metadata & {
  type: (type: "MOBILE") => MobileNumberTypeMetadata | undefined;
};

const mobileNumberLengthCache = new Map<
  string,
  { minimum: number; maximum: number }
>();

export function getMobileNumberLengthRange(countryValue: string): {
  minimum: number;
  maximum: number;
} {
  const dialCode = getCountryOption(countryValue).dialCode;
  const cacheKey = `${countryValue}:${dialCode}`;
  const cached = mobileNumberLengthCache.get(cacheKey);
  if (cached) return cached;

  const fallbackMaximum = Math.max(
    1,
    E164_MAX_DIGITS - dialCode.replace(/\D/g, "").length,
  );
  let range = { minimum: 1, maximum: fallbackMaximum };

  try {
    const metadata = new Metadata(mobilePhoneMetadata);
    metadata.selectNumberingPlan(countryValue as CountryCode);
    // The package exposes this metadata view at runtime but not in its TS API.
    const mobileType = (metadata as MobileAwareMetadata).type("MOBILE");
    const possibleLengths = (mobileType?.possibleLengths() ?? [])
      .filter(
        (length) =>
          Number.isInteger(length) && length > 0 && length <= fallbackMaximum,
      )
      .sort((left, right) => left - right);
    if (possibleLengths.length > 0) {
      range = {
        minimum: possibleLengths[0]!,
        maximum: possibleLengths[possibleLengths.length - 1]!,
      };
    }
  } catch {
    // Invalid programmatic values use the E.164 bound above.
  }

  mobileNumberLengthCache.set(cacheKey, range);
  return range;
}

function composePhoneNumber(
  dialCode: string,
  localPhoneNumber: string,
): string {
  return `${sanitizeDialCode(dialCode)}${sanitizeLocalPhoneNumber(localPhoneNumber)}`;
}

export function derivePhoneFields(phoneNumber?: string | null): {
  countryValue: string;
  localPhoneNumber: string;
} {
  const normalizedPhone = String(phoneNumber ?? "").trim();
  if (!normalizedPhone) {
    return {
      countryValue: DEFAULT_COUNTRY_VALUE,
      localPhoneNumber: "",
    };
  }

  const parsedPhone = parsePhoneNumberFromString(
    normalizedPhone,
    mobilePhoneMetadata,
  );
  const parsedCountry = parsedPhone?.country;
  const matchingOption =
    (parsedCountry
      ? PHONE_COUNTRY_OPTIONS.find((option) => option.value === parsedCountry)
      : undefined) ?? getCountryOptionForPhoneNumber(normalizedPhone);

  if (matchingOption) {
    return {
      countryValue: matchingOption.value,
      localPhoneNumber: parsedPhone?.nationalNumber ?? sanitizeLocalPhoneNumber(
        normalizedPhone.slice(matchingOption.dialCode.length),
      ),
    };
  }

  return {
    countryValue: DEFAULT_COUNTRY_VALUE,
    localPhoneNumber: sanitizeLocalPhoneNumber(
      normalizedPhone.replace(/^\+\d{1,4}/, ""),
    ),
  };
}

export function getPhoneNumberValidationError(
  phoneNumber?: string | null,
  countryValue?: string,
): string | null {
  const normalizedPhone = String(phoneNumber ?? "").trim();
  if (!E164_PHONE_PATTERN.test(normalizedPhone)) {
    return "Enter a valid country code and phone number.";
  }

  const fields = derivePhoneFields(normalizedPhone);
  const resolvedCountry = countryValue ?? fields.countryValue;
  const countryOption = getCountryOption(resolvedCountry);
  const nationalNumber = normalizedPhone.startsWith(countryOption.dialCode)
    ? sanitizeLocalPhoneNumber(
        normalizedPhone.slice(countryOption.dialCode.length),
      )
    : fields.localPhoneNumber;
  const lengthRange = getMobileNumberLengthRange(resolvedCountry);

  if (nationalNumber.length < lengthRange.minimum) {
    return `Enter a complete mobile number for ${countryOption.label}.`;
  }
  if (nationalNumber.length > lengthRange.maximum) {
    return `Enter no more than ${lengthRange.maximum} digits for ${countryOption.label}.`;
  }

  const parsedPhone = parsePhoneNumberFromString(
    normalizedPhone,
    mobilePhoneMetadata,
  );
  if (parsedPhone?.number !== normalizedPhone) {
    return `Enter the mobile number without a local leading prefix after ${countryOption.dialCode}.`;
  }
  if (!parsedPhone?.isValid()) {
    return `Enter a valid mobile number for ${countryOption.label}.`;
  }

  return null;
}

export function maskPhoneNumberForOtp(
  phoneNumber?: string | null,
): string {
  const localPhoneNumber = derivePhoneFields(phoneNumber).localPhoneNumber;
  if (!localPhoneNumber) return "";
  if (localPhoneNumber.length <= 4) return localPhoneNumber;

  return `${"•".repeat(localPhoneNumber.length - 4)} ${localPhoneNumber.slice(-4)}`;
}

export function resolvePhoneInputChange(value: string): {
  countryValue?: string;
  localPhoneNumber: string;
} {
  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith("+")) {
    return {
      localPhoneNumber: sanitizeLocalPhoneNumber(value),
    };
  }

  return derivePhoneFields(trimmedValue);
}

export function PhoneVerificationFlow({
  mode,
  currentPhoneNumber,
  startVerification,
  confirmVerification,
  onCompleted,
  onContinueExisting,
  onCancel,
  confirmLabel,
  className,
  helperText,
  style,
  onStepChange,
}: PhoneVerificationFlowProps) {
  const pathname = usePathname();
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_COUNTRY_VALUE);
  const [countryQuery, setCountryQuery] = useState("");
  const [countryComboboxOpen, setCountryComboboxOpen] = useState(false);
  const suppressNextCountryFocusOpenRef = useRef(false);
  const [localPhoneNumber, setLocalPhoneNumber] = useState("");
  const [phoneNumberError, setPhoneNumberError] = useState<string | null>(null);
  const [submittedPhoneNumber, setSubmittedPhoneNumber] = useState(
    currentPhoneNumber || "",
  );
  const [verificationCode, setVerificationCode] = useState("");
  const [step, setStep] = useState<VerificationStep>(
    mode === "link" && currentPhoneNumber ? "linked" : "phone",
  );
  const [busy, setBusy] = useState(false);
  // State updates do not land until after the current event. These refs keep
  // an Enter keypress and a pointer activation from starting two auth attempts
  // in the same turn.
  const startVerificationAttemptRef = useRef(false);
  const confirmVerificationAttemptRef = useRef(false);

  useEffect(() => {
    const nextFields = derivePhoneFields(currentPhoneNumber);
    setSelectedCountry(nextFields.countryValue);
    setLocalPhoneNumber(nextFields.localPhoneNumber);
    setPhoneNumberError(null);
    setSubmittedPhoneNumber(currentPhoneNumber || "");
    setCountryQuery("");
    setVerificationCode("");
    setStep(mode === "link" && currentPhoneNumber ? "linked" : "phone");
  }, [currentPhoneNumber, mode]);

  useEffect(() => {
    onStepChange?.(step);
  }, [onStepChange, step]);

  const maskedPhone = useMemo(
    // Same read-back as the Account row that opens this flow, so the number
    // does not change shape between the two screens.
    () => formatMaskedPhoneNumber(currentPhoneNumber),
    [currentPhoneNumber],
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
  const normalizedPhoneInput = useMemo(
    () => composePhoneNumber(activeDialCode, localPhoneNumber),
    [activeDialCode, localPhoneNumber],
  );
  const mobileNumberLengthRange = useMemo(
    () => getMobileNumberLengthRange(selectedCountry),
    [selectedCountry],
  );

  const handleCountrySelection = useCallback((value: string | null) => {
    if (!value) {
      return;
    }

    const nextOption = PHONE_COUNTRY_OPTIONS.find(
      (option) => option.value === value,
    );
    if (!nextOption) {
      return;
    }

    setSelectedCountry(nextOption.value);
    const maximum = getMobileNumberLengthRange(nextOption.value).maximum;
    setPhoneNumberError(
      localPhoneNumber.length > maximum
        ? `Enter no more than ${maximum} digits for ${nextOption.label}.`
        : null,
    );
    setCountryQuery("");
    setCountryComboboxOpen(false);
  }, [localPhoneNumber.length]);

  useLocalOnboardingActionHandler("phone_mandate.select_country", (slots) => {
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
      document.getElementById("phone-flow-country")?.focus();
      suppressNextCountryFocusOpenRef.current = false;
    });
    return { status: "succeeded", summary: "Country picker closed." };
  });

  usePublishVoiceSurfaceMetadata(
    pathname === ROUTES.PHONE_MANDATE && countryComboboxOpen
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

  const handlePhoneNumberChange = useCallback((value: string) => {
    const nextInput = resolvePhoneInputChange(value);
    const nextCountry = nextInput.countryValue ?? selectedCountry;
    const nextOption = getCountryOption(nextCountry);
    const maximum = getMobileNumberLengthRange(nextCountry).maximum;
    if (nextInput.localPhoneNumber.length > maximum) {
      // Reject instead of truncating into a different recipient.
      setPhoneNumberError(
        `Enter no more than ${maximum} digits for ${nextOption.label}.`,
      );
      return;
    }
    if (nextInput.countryValue) {
      setSelectedCountry(nextOption.value);
      setCountryQuery("");
    }
    setLocalPhoneNumber(nextInput.localPhoneNumber);
    setPhoneNumberError(null);
  }, [selectedCountry]);

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
    ): Promise<StartVerificationOutcome> => {
      if (busy || startVerificationAttemptRef.current) {
        return "busy";
      }
      const normalizedPhone = (
        phoneNumberOverride ?? normalizedPhoneInput
      ).trim();
      const validationCountry = phoneNumberOverride
        ? derivePhoneFields(normalizedPhone).countryValue
        : selectedCountry;
      if (!phoneNumberOverride && phoneNumberError) {
        morphyToast.error(phoneNumberError);
        return "invalid";
      }
      const validationError = getPhoneNumberValidationError(
        normalizedPhone,
        validationCountry,
      );
      if (validationError) {
        setPhoneNumberError(validationError);
        morphyToast.error(validationError);
        return "invalid";
      }
      setPhoneNumberError(null);

      if (currentPhoneNumber && normalizedPhone === currentPhoneNumber) {
        trackEvent("phone_verification_completed", {
          action: "existing",
          result: "success",
        });
        morphyToast.success(
          "This phone number is already linked to your account.",
        );
        await onCompleted();
        return "already_linked";
      }

      startVerificationAttemptRef.current = true;
      setBusy(true);
      try {
        const result = await startVerification(normalizedPhone, { resendCode });
        trackEvent("phone_verification_started", {
          action: mode,
          result: "success",
        });
        if (result.autoVerified) {
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
        setStep("code");
        morphyToast.success(
          resendCode
            ? "A new verification code has been sent."
            : "Verification code sent.",
        );
        return "code_sent";
      } catch (error) {
        console.error(
          "[PhoneVerificationFlow] Failed to start verification:",
          error,
        );
        trackEvent("phone_verification_started", {
          action: mode,
          result: "error",
        });
        if (isPhoneTakenByAnotherAccount(error)) {
          void ApiService.notifyAuthMail("phone_conflict", {
            phoneNumber: normalizedPhone,
          });
        }
        morphyToast.error(
          error instanceof Error
            ? error.message
            : "Failed to send verification code.",
        );
        return "failed";
      } finally {
        startVerificationAttemptRef.current = false;
        setBusy(false);
      }
    },
    [
      currentPhoneNumber,
      mode,
      normalizedPhoneInput,
      onCompleted,
      phoneNumberError,
      selectedCountry,
      startVerification,
      busy,
    ],
  );

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
      if (busy || confirmVerificationAttemptRef.current) {
        return "busy";
      }

      confirmVerificationAttemptRef.current = true;
      setBusy(true);
      try {
        const verifiedUser = await confirmVerification(normalizedCode);
        trackEvent("phone_verification_completed", {
          action: mode,
          result: "success",
        });
        await onCompleted(verifiedUser);
        if (options.notify) {
          morphyToast.success(
            mode === "replace" ? "Phone number updated." : "Phone number verified.",
          );
        }
        return "verified";
      } catch (error) {
        console.error(
          "[PhoneVerificationFlow] Failed to confirm verification code:",
          error,
        );
        trackEvent("phone_verification_completed", {
          action: mode,
          result: "error",
        });
        // The link only fails on the code step, so this is where the conflict
        // usually surfaces.
        if (isPhoneTakenByAnotherAccount(error) && submittedPhoneNumber) {
          void ApiService.notifyAuthMail("phone_conflict", {
            phoneNumber: submittedPhoneNumber,
          });
        }
        if (options.notify) {
          morphyToast.error(
            error instanceof Error
              ? error.message
              : "Failed to verify the phone number.",
          );
        }
        return "failed";
      } finally {
        confirmVerificationAttemptRef.current = false;
        setBusy(false);
      }
    },
    [busy, confirmVerification, mode, onCompleted, submittedPhoneNumber],
  );

  const handleConfirmVerification = useCallback(async () => {
    await submitVerificationCode(verificationCode, { notify: true });
  }, [submitVerificationCode, verificationCode]);

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
          onClick={() => void onContinueExisting?.()}
          size="default"
          fullWidth
          className={`type-headline mt-6 h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <form className={className} style={style} noValidate onSubmit={handleSubmit}>
      <FieldSet>
      {step === "phone" ? (
        <>
          <FieldGroup className="gap-5">
            <Field className="gap-2.5">
              <FieldLabel htmlFor="phone-flow-country">Country code</FieldLabel>
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
                  className={`${FLOW_CONTROL_SHELL_CLASS_NAME} w-full`}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  showTrigger
                />
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
            </Field>

            <Field className="gap-2.5">
              <FieldLabel htmlFor="phone-flow-number">Phone number</FieldLabel>
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
                  placeholder="6505550101"
                  className={FLOW_CONTROL_CLASS_NAME}
                />
              </InputGroup>
              {phoneNumberError ? (
                <FieldDescription
                  id="phone-flow-number-error"
                  role="alert"
                  className="text-sm font-semibold text-destructive"
                >
                  {phoneNumberError}
                </FieldDescription>
              ) : null}
            </Field>
          </FieldGroup>

          {helperText ? (
            <FieldDescription className="type-callout text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]">
              {helperText}
            </FieldDescription>
          ) : null}
          <div className="grid gap-3">
            <Button
              type="submit"
              loading={busy}
              variant="none"
              effect="fill"
              size="default"
              fullWidth
              className={`type-headline ${FLOW_CTA_CLASS_NAME}`}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                "Send verification code"
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
          <p className="text-center text-sm leading-6 text-muted-foreground">
            Enter the code sent to{" "}
            <span className="font-semibold text-foreground">
              {maskPhoneNumberForOtp(submittedPhoneNumber)}
            </span>
            .
          </p>

          <Field className="gap-2.5">
            <FieldLabel htmlFor="phone-flow-code">One-time code</FieldLabel>
            <div className="relative">
              <div className="flex gap-2.5">
                {Array.from({ length: 6 }).map((_, index) => {
                  const active = index === Math.min(verificationCode.length, 5);
                  const filled = index < verificationCode.length;
                  return (
                    <div
                      key={index}
                      className={cn(
                        "flex h-[58px] flex-1 items-center justify-center rounded-2xl border-[1.5px] text-[24px] font-bold text-[#0A0A0A] transition-colors dark:text-white",
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
                aria-label="One-time code"
                value={verificationCode}
                onChange={(event) =>
                  setVerificationCode(
                    event.target.value.replace(/\D/g, "").slice(0, 6),
                  )
                }
                autoFocus
                enterKeyHint="done"
                className="absolute inset-0 h-full w-full cursor-default rounded-2xl opacity-0 outline-none"
              />
            </div>
          </Field>

          <Button
            type="submit"
            loading={busy}
            disabled={busy || verificationCode.length !== 6}
            variant="none"
            effect="fill"
            size="default"
            fullWidth
            className={`type-headline ${FLOW_CTA_CLASS_NAME}`}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              confirmLabel || "Verify and continue"
            )}
          </Button>

          <div className="flex items-center justify-center gap-3 pt-1 text-[15px]">
            <button
              type="button"
              onClick={() => void handleStartVerification(true)}
              disabled={busy}
              className="font-bold text-[color:var(--app-accent-deep)] transition-colors hover:text-[color:var(--app-accent-deep)] disabled:opacity-50 dark:text-[color:var(--app-accent-deep)]"
            >
              Resend code
            </button>
            <span aria-hidden className="text-black/25 dark:text-white/30">
              ·
            </span>
            <button
              type="button"
              onClick={() => setStep("phone")}
              disabled={busy}
              className="font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Use a different number
            </button>
          </div>
        </>
      )}
      </FieldSet>
    </form>
  );
}
