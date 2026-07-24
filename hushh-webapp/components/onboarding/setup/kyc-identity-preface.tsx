"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { Input } from "@/components/ui/input";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import {
  KycIdentityProfilePkmService,
  type KycIdentityProfile,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

const STEPS = [
  { id: "legal-name", label: "Legal name" },
  { id: "date-of-birth", label: "Date of birth" },
  { id: "residence", label: "Primary residence" },
] as const;

export function KycIdentityPreface({ onComplete }: { onComplete: () => void }) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [step, setStep] = useState(0);
  const [legalName, setLegalName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [vaultOpen, setVaultOpen] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<KycIdentityProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const attemptedProfileRef = useRef<string | null>(null);

  const selectedCountry = useMemo(
    () => COUNTRY_PHONE_OPTIONS.find((country) => country.value === countryCode),
    [countryCode],
  );
  const canContinue =
    step === 0
      ? legalName.trim().length > 1
      : step === 1
        ? Boolean(dateOfBirth)
        : Boolean(selectedCountry);

  const saveProfile = useCallback(
    async (profile: KycIdentityProfile) => {
      if (!user?.uid || !vaultKey || !vaultOwnerToken) return;

      const attemptKey = `${profile.legalName}|${profile.dateOfBirth}|${profile.countryCode}`;
      if (attemptedProfileRef.current === attemptKey) return;
      attemptedProfileRef.current = attemptKey;
      setSaving(true);

      try {
        const result = await KycIdentityProfilePkmService.saveProfile({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
          profile,
        });
        if (!result.success) {
          throw new Error(result.message);
        }
        toast.success("Identity details saved to your private vault.");
        setPendingProfile(null);
        setVaultOpen(false);
        onComplete();
      } catch {
        attemptedProfileRef.current = null;
        toast.error("We couldn't save your identity details. Please try again.");
      } finally {
        setSaving(false);
      }
    },
    [onComplete, user?.uid, vaultKey, vaultOwnerToken],
  );

  useEffect(() => {
    if (!pendingProfile || !vaultKey || !vaultOwnerToken) return;
    void saveProfile(pendingProfile);
  }, [pendingProfile, saveProfile, vaultKey, vaultOwnerToken]);

  const handlePrimary = () => {
    if (!canContinue || saving) return;
    if (step < STEPS.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    if (!user?.uid || !selectedCountry) {
      toast.error("Sign in before saving your identity details.");
      return;
    }

    const profile = {
      legalName: legalName.trim(),
      dateOfBirth,
      countryCode: selectedCountry.value,
      countryName: selectedCountry.label,
    };
    setPendingProfile(profile);
    if (!vaultKey || !vaultOwnerToken) {
      setVaultOpen(true);
    }
  };

  const primaryLabel = step === STEPS.length - 1 ? "Save and continue" : "Next";

  return (
    <main
      data-top-content-anchor="true"
      className="flex min-h-[100dvh] w-full flex-col bg-transparent px-5 pb-[var(--app-screen-footer-pad)] pt-[var(--top-content-pad)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
    >
      <div className="mx-auto flex min-h-[calc(100dvh-var(--top-content-pad)-var(--app-screen-footer-pad))] w-full max-w-[25rem] flex-col justify-center py-6">
        <div className="w-full">
          <div className="space-y-2.5">
            <div className="flex min-h-8 items-center justify-between gap-3">
              <Button
                type="button"
                variant="link"
                effect="fade"
                size="sm"
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                disabled={step === 0 || saving}
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
              <span className="type-footnote tabular-nums text-muted-foreground">
                Step {step + 1} of {STEPS.length}
              </span>
            </div>
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
                This information stays encrypted in your private vault.
              </p>
              <h1 className="type-title1 text-balance text-foreground">
                {step === 0
                  ? "What is your legal name?"
                  : step === 1
                    ? "What is your date of birth?"
                    : "Where is your primary residence?"}
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
                  disabled={saving}
                  className="h-14 rounded-xl px-4 text-base"
                  aria-label="Legal name"
                />
              ) : null}
              {step === 1 ? (
                <Input
                  type="date"
                  value={dateOfBirth}
                  onChange={(event) => setDateOfBirth(event.target.value)}
                  autoComplete="bday"
                  disabled={saving}
                  className="h-14 rounded-xl px-4 text-base"
                  aria-label="Date of birth"
                />
              ) : null}
              {step === 2 ? (
                <select
                  value={countryCode}
                  onChange={(event) => setCountryCode(event.target.value)}
                  autoComplete="country-name"
                  disabled={saving}
                  aria-label="Primary residence"
                  className="h-14 w-full appearance-none rounded-xl border border-input bg-background px-4 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                >
                  <option value="">Select country or region</option>
                  {COUNTRY_PHONE_OPTIONS.map((country) => (
                    <option key={country.value} value={country.value}>
                      {country.label}
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
                disabled={!canContinue || saving}
                loading={saving}
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
                {saving ? "Saving to your private vault..." : primaryLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultOpen}
          onOpenChange={setVaultOpen}
          title="Open your private vault"
          description="Your KYC identity details are encrypted before they are saved."
          onSuccess={() => setVaultOpen(false)}
        />
      ) : null}
    </main>
  );
}
