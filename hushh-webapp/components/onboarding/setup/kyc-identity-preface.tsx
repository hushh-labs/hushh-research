"use client";

import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import {
  isValidDateOfBirth,
  KycIdentityProfileDraftService,
  type KycEmploymentStatus,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "legal-name", label: "Legal name" },
  { id: "date-of-birth", label: "Date of birth" },
  { id: "citizenship", label: "Citizenship" },
  { id: "employment", label: "Employment" },
] as const;

const EMPLOYMENT_OPTIONS: ReadonlyArray<{
  value: KycEmploymentStatus;
  label: string;
}> = [
  { value: "employed", label: "Employed" },
  { value: "self_employed", label: "Self-employed" },
  { value: "student", label: "Student" },
  { value: "retired", label: "Retired" },
  { value: "not_currently_employed", label: "Not currently employed" },
];

export function KycIdentityPreface({ onComplete }: { onComplete: () => void }) {
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [legalName, setLegalName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [citizenshipCountryCode, setCitizenshipCountryCode] = useState("");
  const [employmentStatus, setEmploymentStatus] =
    useState<KycEmploymentStatus | "">("");
  const latestDateOfBirth = useMemo(() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return [
      yesterday.getFullYear(),
      String(yesterday.getMonth() + 1).padStart(2, "0"),
      String(yesterday.getDate()).padStart(2, "0"),
    ].join("-");
  }, []);

  const selectedCountry = useMemo(
    () =>
      COUNTRY_PHONE_OPTIONS.find(
        (country) => country.value === citizenshipCountryCode,
      ),
    [citizenshipCountryCode],
  );
  const canContinue =
    step === 0
      ? legalName.trim().length > 1
      : step === 1
        ? isValidDateOfBirth(dateOfBirth)
        : step === 2
          ? Boolean(selectedCountry)
          : Boolean(employmentStatus);
  const hasCompleteProfile =
    legalName.trim().length > 1 &&
    isValidDateOfBirth(dateOfBirth) &&
    Boolean(selectedCountry) &&
    Boolean(employmentStatus);
  const dateOfBirthInvalid =
    Boolean(dateOfBirth) && !isValidDateOfBirth(dateOfBirth);

  const handlePrimary = () => {
    if (!canContinue) return;
    if (step < STEPS.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    if (!hasCompleteProfile) {
      onComplete();
      return;
    }
    if (!user?.uid || !selectedCountry) {
      toast.error("Sign in before saving your identity details.");
      return;
    }

    const profile = {
      legalName: legalName.trim(),
      dateOfBirth,
      citizenshipCountryCode: selectedCountry.value,
      citizenshipCountryName: selectedCountry.label,
      employmentStatus: employmentStatus as KycEmploymentStatus,
    };
    // Capability setup is deliberately vault-free. Keep the sensitive draft
    // only in process memory; the root Finish setup action is the one place
    // that introduces the vault and flushes this profile after unlock.
    KycIdentityProfileDraftService.stage(user.uid, profile);
    onComplete();
  };

  const handleSkip = () => {
    if (step < STEPS.length - 1) {
      setStep((current) => current + 1);
      return;
    }

    onComplete();
  };

  const primaryLabel = "Next";

  return (
    <CapabilityCinematicIntroGate capabilityId="email">
      <main
        data-top-content-anchor="true"
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-transparent px-5 pb-[var(--app-screen-footer-pad)] pt-[var(--top-content-pad)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
      >
        <div className="mx-auto flex min-h-0 w-full max-w-[25rem] flex-1 flex-col justify-start pb-0 pt-2 sm:pt-4">
          <div className="w-full">
            <div className="space-y-2.5">
              <div className="flex min-h-8 items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="link"
                  effect="fade"
                  size="sm"
                  onClick={() => setStep((current) => Math.max(0, current - 1))}
                  disabled={step === 0}
                  className={cn(
                    "h-8 rounded-full px-2.5 text-[14px] font-medium text-primary hover:bg-primary/10",
                    step === 0 && "invisible pointer-events-none",
                  )}
                  showRipple={false}
                  aria-label="Previous question"
                  tabIndex={step === 0 ? -1 : 0}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
                <Button
                  type="button"
                  variant="link"
                  effect="fade"
                  size="sm"
                  onClick={handleSkip}
                  className="h-8 rounded-full px-2.5 text-[14px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  showRipple={false}
                  aria-label={
                    step === STEPS.length - 1
                      ? "Skip KYC setup"
                      : "Skip this question"
                  }
                >
                  Skip
                </Button>
              </div>
              <span className="block text-right type-footnote tabular-nums text-muted-foreground">
                Step {step + 1} of {STEPS.length}
              </span>
              <OnboardingStepper
                steps={STEPS}
                currentIndex={step}
                showLabel={false}
                ariaLabel="KYC identity setup"
              />
            </div>

            <div className="mx-auto flex w-full flex-col pt-8 sm:pt-9">
              <div className="space-y-2 text-left">
                <p className="type-subhead text-muted-foreground">
                  A few details to get started.
                </p>
                <h1 className="type-title1 text-balance text-foreground">
                  {step === 0
                    ? "What is your legal name?"
                    : step === 1
                      ? "What is your date of birth?"
                      : step === 2
                        ? "What is your country of citizenship?"
                        : "Which best describes your employment?"}
                </h1>
              </div>

              <div className="mt-8 sm:mt-9">
                {step === 0 ? (
                  <Input
                    value={legalName}
                    onChange={(event) => setLegalName(event.target.value)}
                    placeholder="Full legal name"
                    autoComplete="name"
                    autoCapitalize="words"
                    className="h-14 rounded-xl px-4 text-base"
                    aria-label="Legal name"
                  />
                ) : null}
                {step === 1 ? (
                  <>
                    <Input
                      type="date"
                      value={dateOfBirth}
                      onChange={(event) => setDateOfBirth(event.target.value)}
                      autoComplete="bday"
                      max={latestDateOfBirth}
                      className="h-14 rounded-xl px-4 text-base"
                      aria-label="Date of birth"
                      aria-describedby={
                        dateOfBirthInvalid ? "date-of-birth-error" : undefined
                      }
                    />
                    {dateOfBirthInvalid ? (
                      <p
                        id="date-of-birth-error"
                        role="alert"
                        className="mt-2 text-sm text-destructive"
                      >
                        Enter a real date of birth in the past.
                      </p>
                    ) : null}
                  </>
                ) : null}
                {step === 2 ? (
                  <select
                    value={citizenshipCountryCode}
                    onChange={(event) =>
                      setCitizenshipCountryCode(event.target.value)
                    }
                    autoComplete="country"
                    aria-label="Country of citizenship"
                    className="h-14 w-full appearance-none rounded-xl border border-input bg-background px-4 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                  >
                    <option value="">Select country</option>
                    {COUNTRY_PHONE_OPTIONS.map((country) => (
                      <option key={country.value} value={country.value}>
                        {country.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {step === 3 ? (
                  <select
                    value={employmentStatus}
                    onChange={(event) =>
                      setEmploymentStatus(
                        event.target.value as KycEmploymentStatus | "",
                      )
                    }
                    aria-label="Employment status"
                    className="h-14 w-full appearance-none rounded-xl border border-input bg-background px-4 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                  >
                    <option value="">Select an option</option>
                    {EMPLOYMENT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>

              <div className="space-y-3 pt-8">
                <Button
                  type="button"
                  variant="none"
                  effect="fill"
                  size="lg"
                  fullWidth
                  onClick={handlePrimary}
                  disabled={!canContinue}
                  showRipple
                  className={cn(
                    "h-12 rounded-full type-headline",
                    "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
                    "active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100",
                    canContinue
                      ? "!bg-primary !text-primary-foreground hover:!bg-primary/90"
                      : "!bg-muted !text-muted-foreground",
                  )}
                >
                  {primaryLabel}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </CapabilityCinematicIntroGate>
  );
}
