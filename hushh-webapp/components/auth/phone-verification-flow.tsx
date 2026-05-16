"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { Loader2, ShieldCheck } from "lucide-react";

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Button } from "@/lib/morphy-ux/button";
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

const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const DEFAULT_COUNTRY_VALUE = "US";
const FLOW_CONTROL_SHELL_CLASS_NAME =
  "h-12 overflow-hidden rounded-[var(--radius-md)] border-black/10 bg-background/80 shadow-xs dark:border-white/10 dark:bg-input/30";
const FLOW_CONTROL_CLASS_NAME =
  "h-full rounded-[inherit] border-0 bg-transparent px-4 text-base shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent md:text-sm";
const FLOW_SURFACE_RADIUS_CLASS_NAME = "rounded-[var(--radius-md)]";

export type PhoneVerificationFlowMode = "link" | "replace";

type PhoneVerificationFlowProps = {
  mode: PhoneVerificationFlowMode;
  currentPhoneNumber?: string | null;
  startVerification: (
    phoneNumber: string,
    options?: { resendCode?: boolean }
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

function getCountryOptionLabel(option: {
  label: string;
  dialCode: string;
}): string {
  return `${option.label} (${option.dialCode})`;
}

function getCountryOption(value: string): CountryPhoneOption {
  return COUNTRY_PHONE_OPTIONS.find((option) => option.value === value) ?? COUNTRY_PHONE_OPTIONS[0]!;
}

function getCountryOptionForPhoneNumber(phoneNumber: string): CountryPhoneOption | undefined {
  const matchingOptions = COUNTRY_PHONE_OPTIONS.filter((option) =>
    phoneNumber.startsWith(option.dialCode)
  ).sort((left, right) => right.dialCode.length - left.dialCode.length);
  const firstMatch = matchingOptions[0];
  if (!firstMatch) {
    return undefined;
  }

  const longestDialCodeLength = firstMatch.dialCode.length;
  const longestMatches = matchingOptions.filter(
    (option) => option.dialCode.length === longestDialCodeLength
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

function composePhoneNumber(dialCode: string, localPhoneNumber: string): string {
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
        normalizedPhone.slice(matchingOption.dialCode.length)
      ),
    };
  }

  return {
    countryValue: DEFAULT_COUNTRY_VALUE,
    localPhoneNumber: sanitizeLocalPhoneNumber(normalizedPhone.replace(/^\+\d{1,4}/, "")),
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
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_COUNTRY_VALUE);
  const [countryQuery, setCountryQuery] = useState("");
  const [countryComboboxOpen, setCountryComboboxOpen] = useState(false);
  const [localPhoneNumber, setLocalPhoneNumber] = useState("");
  const [submittedPhoneNumber, setSubmittedPhoneNumber] = useState(currentPhoneNumber || "");
  const [verificationCode, setVerificationCode] = useState("");
  const [step, setStep] = useState<VerificationStep>(
    mode === "link" && currentPhoneNumber ? "linked" : "phone"
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const nextFields = derivePhoneFields(currentPhoneNumber);
    setSelectedCountry(nextFields.countryValue);
    setLocalPhoneNumber(nextFields.localPhoneNumber);
    setSubmittedPhoneNumber(currentPhoneNumber || "");
    setCountryQuery(
      getCountryOptionLabel(
        getCountryOption(nextFields.countryValue)
      )
    );
    setVerificationCode("");
    setStep(mode === "link" && currentPhoneNumber ? "linked" : "phone");
  }, [currentPhoneNumber, mode]);

  const maskedPhone = useMemo(() => maskPhoneNumber(currentPhoneNumber), [currentPhoneNumber]);
  const selectedCountryOption = useMemo(
    () => COUNTRY_PHONE_OPTIONS.find((option) => option.value === selectedCountry),
    [selectedCountry]
  );
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
    [selectedCountryOption]
  );
  const normalizedPhoneInput = useMemo(
    () => composePhoneNumber(activeDialCode, localPhoneNumber),
    [activeDialCode, localPhoneNumber]
  );

  const handleCountrySelection = useCallback((value: string | null) => {
    if (!value) {
      return;
    }

    const nextOption = COUNTRY_PHONE_OPTIONS.find((option) => option.value === value);
    if (!nextOption) {
      return;
    }

    setSelectedCountry(nextOption.value);
    setCountryQuery(getCountryOptionLabel(nextOption));
    setCountryComboboxOpen(false);
  }, []);

  const handlePhoneNumberChange = useCallback((value: string) => {
    const nextInput = resolvePhoneInputChange(value);
    if (nextInput.countryValue) {
      const nextOption = getCountryOption(nextInput.countryValue);
      setSelectedCountry(nextOption.value);
      setCountryQuery(getCountryOptionLabel(nextOption));
    }
    setLocalPhoneNumber(nextInput.localPhoneNumber);
  }, []);

  const handleStartVerification = useCallback(
    async (resendCode = false) => {
      const normalizedPhone = normalizedPhoneInput.trim();
      if (!E164_PHONE_PATTERN.test(normalizedPhone)) {
        morphyToast.error("Enter a valid country code and phone number.");
        return;
      }

      if (currentPhoneNumber && normalizedPhone === currentPhoneNumber) {
        trackEvent("phone_verification_completed", {
          action: "existing",
          result: "success",
        });
        morphyToast.success("This phone number is already linked to your account.");
        await onCompleted();
        return;
      }

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
            mode === "replace" ? "Phone number updated." : "Phone number verified."
          );
          await onCompleted(result.user ?? undefined);
          return;
        }

        setSubmittedPhoneNumber(normalizedPhone);
        setStep("code");
        morphyToast.success(
          resendCode ? "A new verification code has been sent." : "Verification code sent."
        );
      } catch (error) {
        console.error("[PhoneVerificationFlow] Failed to start verification:", error);
        trackEvent("phone_verification_started", {
          action: mode,
          result: "error",
        });
        morphyToast.error(
          error instanceof Error ? error.message : "Failed to send verification code."
        );
      } finally {
        setBusy(false);
      }
    },
    [currentPhoneNumber, mode, normalizedPhoneInput, onCompleted, startVerification]
  );

  const handleConfirmVerification = useCallback(async () => {
    const normalizedCode = verificationCode.trim();
    if (!normalizedCode) {
      morphyToast.error("Enter the verification code you received.");
      return;
    }

    setBusy(true);
    try {
      const verifiedUser = await confirmVerification(normalizedCode);
      trackEvent("phone_verification_completed", {
        action: mode,
        result: "success",
      });
      morphyToast.success(mode === "replace" ? "Phone number updated." : "Phone number verified.");
      await onCompleted(verifiedUser);
    } catch (error) {
      console.error("[PhoneVerificationFlow] Failed to confirm verification code:", error);
      trackEvent("phone_verification_completed", {
        action: mode,
        result: "error",
      });
      morphyToast.error(
        error instanceof Error ? error.message : "Failed to verify the phone number."
      );
    } finally {
      setBusy(false);
    }
  }, [confirmVerification, mode, onCompleted, verificationCode]);

  if (step === "linked") {
    return (
      <div className={className} style={style}>
        <div
          className={`${FLOW_SURFACE_RADIUS_CLASS_NAME} border border-emerald-500/20 bg-emerald-50/80 p-5 dark:bg-emerald-950/20`}
        >
          <ShieldCheck className="h-10 w-10 text-emerald-600" />
          <h2 className="mt-4 text-lg font-semibold text-foreground">Phone already linked</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This account already has a verified phone number:{" "}
            {maskedPhone || "already on this account"}.
          </p>
        </div>
        <Button
          onClick={() => void onContinueExisting?.()}
          size="lg"
          fullWidth
          className={`mt-6 h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <FieldSet className={className} style={style}>
      {step === "phone" ? (
        <>
          <FieldGroup className="gap-5">
            <Field className="gap-2.5">
              <FieldLabel htmlFor="phone-flow-country">Country code</FieldLabel>
              <Combobox
                open={countryComboboxOpen}
                onOpenChange={(open) => {
                  setCountryComboboxOpen(open);
                  if (open) {
                    setCountryQuery("");
                    return;
                  }
                  setCountryQuery(
                    getCountryOptionLabel(selectedCountryOption ?? COUNTRY_PHONE_OPTIONS[0]!)
                  );
                }}
                value={selectedCountry}
                onValueChange={handleCountrySelection}
                items={filteredCountryOptions}
              >
                <ComboboxInput
                  id="phone-flow-country"
                  placeholder="Search country code"
                  value={countryQuery}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setCountryQuery(event.target.value);
                    if (!countryComboboxOpen) {
                      setCountryComboboxOpen(true);
                    }
                  }}
                  onFocus={() => setCountryComboboxOpen(true)}
                  className={`${FLOW_CONTROL_SHELL_CLASS_NAME} w-full`}
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
                              <span className="shrink-0 text-muted-foreground">{item.dialCode}</span>
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
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={localPhoneNumber}
                  onChange={(event) => handlePhoneNumberChange(event.target.value)}
                  placeholder="6505550101"
                  className={FLOW_CONTROL_CLASS_NAME}
                />
              </InputGroup>
            </Field>
          </FieldGroup>

          <FieldDescription className="text-[15px] leading-7 text-muted-foreground">
            {helperText ||
              "Choose your country code and enter your phone number. We’ll send you a verification code."}
          </FieldDescription>
          <div className="grid gap-3">
            <Button
              onClick={() => void handleStartVerification(false)}
              loading={busy}
              size="lg"
              fullWidth
              className={`h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send verification code"}
            </Button>
            {onCancel ? (
              <Button
                onClick={onCancel}
                variant="none"
                effect="fade"
                fullWidth
                disabled={busy}
                className={`h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div
            className={`${FLOW_SURFACE_RADIUS_CLASS_NAME} border border-black/5 bg-neutral-50 p-5 dark:bg-neutral-900/60`}
          >
            <p className="text-sm font-medium text-foreground">Verification code sent</p>
            <p className="mt-2 text-sm text-muted-foreground">
              We sent a verification code to {submittedPhoneNumber}. Enter it to continue.
            </p>
          </div>

          <Field className="gap-2.5">
            <FieldLabel htmlFor="phone-flow-code">One-time code</FieldLabel>
            <InputGroup className={FLOW_CONTROL_SHELL_CLASS_NAME}>
              <InputGroupInput
                id="phone-flow-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value)}
                placeholder="123456"
                className={FLOW_CONTROL_CLASS_NAME}
              />
            </InputGroup>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              onClick={() => void handleConfirmVerification()}
              loading={busy}
              size="lg"
              fullWidth
              className={`h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmLabel || "Verify and continue"}
            </Button>
            <Button
              onClick={() => void handleStartVerification(true)}
              variant="none"
              effect="glass"
              size="lg"
              fullWidth
              disabled={busy}
              className={`h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
            >
              Resend code
            </Button>
          </div>

          <Button
            onClick={() => setStep("phone")}
            variant="none"
            effect="fade"
            fullWidth
            disabled={busy}
            className={`h-12 ${FLOW_SURFACE_RADIUS_CLASS_NAME}`}
          >
            Use a different number
          </Button>
        </>
      )}
    </FieldSet>
  );
}
