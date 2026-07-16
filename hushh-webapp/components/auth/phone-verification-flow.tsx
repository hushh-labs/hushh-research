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
import { Check, Loader2, ShieldCheck } from "lucide-react";
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
import { maskPhoneNumber } from "@/lib/services/phone-mandate-service";
import { trackEvent } from "@/lib/observability/client";
import {
  kaiAppCardTitleClassName,
  kaiAppHelperClassName,
} from "@/components/kai/shared/kai-typography";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
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

function getCountryOptionLabel(option: {
  label: string;
  dialCode: string;
}): string {
  return `${option.label} (${option.dialCode})`;
}

function getCountryOption(value: string): CountryPhoneOption {
  return (
    COUNTRY_PHONE_OPTIONS.find((option) => option.value === value) ??
    COUNTRY_PHONE_OPTIONS[0]!
  );
}

function getCountryOptionForPhoneNumber(
  phoneNumber: string,
): CountryPhoneOption | undefined {
  const matchingOptions = COUNTRY_PHONE_OPTIONS.filter((option) =>
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
  return value.replace(/\D/g, "").slice(0, 15);
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

  const matchingOption = getCountryOptionForPhoneNumber(normalizedPhone);

  if (matchingOption) {
    return {
      countryValue: matchingOption.value,
      localPhoneNumber: sanitizeLocalPhoneNumber(
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
}: PhoneVerificationFlowProps) {
  const pathname = usePathname();
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_COUNTRY_VALUE);
  const [countryQuery, setCountryQuery] = useState("");
  const [countryComboboxOpen, setCountryComboboxOpen] = useState(false);
  const suppressNextCountryFocusOpenRef = useRef(false);
  const [localPhoneNumber, setLocalPhoneNumber] = useState("");
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
    setSubmittedPhoneNumber(currentPhoneNumber || "");
    setCountryQuery("");
    setVerificationCode("");
    setStep(mode === "link" && currentPhoneNumber ? "linked" : "phone");
  }, [currentPhoneNumber, mode]);

  const maskedPhone = useMemo(
    () => maskPhoneNumber(currentPhoneNumber),
    [currentPhoneNumber],
  );
  const selectedCountryOption = useMemo(
    () =>
      COUNTRY_PHONE_OPTIONS.find((option) => option.value === selectedCountry),
    [selectedCountry],
  );
  const selectedCountryLabel = useMemo(
    () =>
      getCountryOptionLabel(selectedCountryOption ?? COUNTRY_PHONE_OPTIONS[0]!),
    [selectedCountryOption],
  );
  const countryInputValue = countryComboboxOpen
    ? countryQuery
    : selectedCountryLabel;
  const filteredCountryOptions = useMemo(() => {
    const normalizedQuery = countryQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return COUNTRY_PHONE_OPTIONS;
    }

    return COUNTRY_PHONE_OPTIONS.filter((option) => {
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
    () => selectedCountryOption?.dialCode ?? COUNTRY_PHONE_OPTIONS[0]!.dialCode,
    [selectedCountryOption],
  );
  const normalizedPhoneInput = useMemo(
    () => composePhoneNumber(activeDialCode, localPhoneNumber),
    [activeDialCode, localPhoneNumber],
  );

  const handleCountrySelection = useCallback((value: string | null) => {
    if (!value) {
      return;
    }

    const nextOption = COUNTRY_PHONE_OPTIONS.find(
      (option) => option.value === value,
    );
    if (!nextOption) {
      return;
    }

    setSelectedCountry(nextOption.value);
    setCountryQuery("");
    setCountryComboboxOpen(false);
  }, []);

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
    if (nextInput.countryValue) {
      const nextOption = getCountryOption(nextInput.countryValue);
      setSelectedCountry(nextOption.value);
      setCountryQuery("");
    }
    setLocalPhoneNumber(nextInput.localPhoneNumber);
  }, []);

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
      if (!E164_PHONE_PATTERN.test(normalizedPhone)) {
        morphyToast.error("Enter a valid country code and phone number.");
        return "invalid";
      }

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
    [busy, confirmVerification, mode, onCompleted],
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
                  setCountryQuery("");
                }}
                value={selectedCountry}
                onValueChange={handleCountrySelection}
                items={filteredCountryOptions}
              >
                <ComboboxInput
                  id="phone-flow-country"
                  data-voice-control-id="phone-flow-country"
                  placeholder="Search country code"
                  value={countryInputValue}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setCountryQuery(event.target.value);
                    if (!countryComboboxOpen) {
                      setCountryComboboxOpen(true);
                    }
                  }}
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
                              <span className="shrink-0 text-muted-foreground">
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
                  value={localPhoneNumber}
                  onChange={(event) =>
                    handlePhoneNumberChange(event.target.value)
                  }
                  placeholder="6505550101"
                  className={FLOW_CONTROL_CLASS_NAME}
                />
              </InputGroup>
            </Field>
          </FieldGroup>

          <FieldDescription className="type-callout text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]">
            {helperText ||
              "Choose your country code and enter your phone number. We’ll send you a verification code."}
          </FieldDescription>
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
          <div className="flex items-start gap-3 rounded-2xl border border-[rgba(18,161,80,0.35)] bg-[rgba(18,161,80,0.08)] p-4 dark:border-[rgba(18,161,80,0.35)] dark:bg-[rgba(18,161,80,0.16)]">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#12A150] text-white">
              <Check className="h-3 w-3" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-bold tracking-[-0.2px] text-[#0A0A0A] dark:text-white">
                Verification code sent
              </p>
              <p className="mt-0.5 text-[13.5px] leading-[1.4] text-black/55 dark:text-white/60">
                We sent a verification code to{" "}
                <span className="font-semibold text-foreground">
                  {submittedPhoneNumber}
                </span>
                . Enter it to continue.
              </p>
              <p className="mt-1 text-[12px] leading-[1.35] text-black/45 dark:text-white/50">
                You can type the code or say it to One. Spoken codes are
                processed by the voice service and are not retained by Hussh.
              </p>
            </div>
          </div>

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
