"use client";

import { useRef, useState } from "react";
import { Brain, Check, Copy } from "@/components/icons";
import { toast } from "sonner";

import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import {
  isValidDateOfBirth,
  type KycIdentityProfile,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { cn } from "@/lib/utils";

import { useVault } from "@/lib/vault/vault-context";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";

const EXTERNAL_PROFILE_EXPORT_PROMPT =
  "Can you share one to two pages of the information you have about me for an external agent? Use simple Markdown bullet points under Facts, Preferences, and Commitments. Include any KYC-related information you have, and clearly note anything uncertain or missing. Do not include passwords, PINs, security codes, or authentication keys.";

export function KycIdentityPreface({ onComplete }: { onComplete: () => void }) {
  const { user, userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [aboutMe, setAboutMe] = useState("");
  // Typed by the person, never read off the export. The pasted summary is
  // written by another assistant and is not evidence of a legal name, a real
  // birth date, or a sex: those are stated here or not recorded at all.
  const [legalName, setLegalName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [sex, setSex] = useState("");
  const [copied, setCopied] = useState(false);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [isSaveStarted, setIsSaveStarted] = useState(false);
  const saveStartedRef = useRef(false);

  // A supplied date must be a real past date before it is stored, because an
  // age is derived from it later and a wrong date is a wrong answer, not a
  // missing one. Left blank it stays absent, which answers honestly.
  const dateOfBirthValid = !dateOfBirth || isValidDateOfBirth(dateOfBirth);
  const canContinue = aboutMe.trim().length > 5 && dateOfBirthValid;

  const handlePrimary = async () => {
    if (!canContinue || saveStartedRef.current) return;
    if (!userId) {
      toast.error("Sign in before saving your details.");
      return;
    }

    const profile: KycIdentityProfile = {
      aboutMe: aboutMe.trim(),
      // Omitted entirely when blank, so nothing is recorded as empty.
      ...(legalName.trim() ? { legalName: legalName.trim() } : {}),
      ...(dateOfBirth ? { dateOfBirth } : {}),
      ...(sex.trim() ? { sex: sex.trim() } : {}),
    };

    if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      // KYC text is sensitive. Keep it on this screen and establish the
      // client-side vault boundary before any onboarding continuation.
      setVaultDialogOpen(true);
      return;
    }

    saveStartedRef.current = true;
    setIsSaveStarted(true);
    const saveTask = KycIdentityProfilePkmService.saveProfile({
      userId,
      vaultKey,
      vaultOwnerToken,
      profile,
    });
    onComplete();
    toast.info("Importing your profile into Memory in the background…");
    void saveTask
      .then((result) => {
        if (!result.success) {
          console.error("[PKM_INGEST] kyc_background_save_failed", {
            source: "kyc_identity_onboarding",
            error_code: "save_incomplete",
          });
          toast.error("We couldn't save your details to Memory. Nothing new was added.");
          return;
        }
        toast.success(result.message || "Your data is now saved in Memory.");
      })
      .catch(() => {
        console.error("[PKM_INGEST] kyc_background_save_failed", {
          source: "kyc_identity_onboarding",
          error_code: "background_task_rejected",
        });
        toast.error("We couldn't save your details to Memory. Nothing new was added.");
      });
  };

  const handleSkip = () => {
    onComplete();
  };

  const copyPrompt = () => {
    navigator.clipboard.writeText(EXTERNAL_PROFILE_EXPORT_PROMPT);
    toast.success("Request copied to clipboard.");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <CapabilityCinematicIntroGate capabilityId="email" routeOwnsTopOffset>
      <div className="mx-auto flex min-h-0 w-full max-w-[32rem] my-auto flex-col justify-center px-4 py-8">
        <div className="w-full space-y-8">
          <div className="flex items-center justify-between">
            <div className="w-16" />
            <div className="h-1.5 w-12 rounded-full bg-muted/50" />
            <div className="flex w-16 justify-end md:justify-center">
              <Button
                type="button"
                variant="link"
                effect="fade"
                size="sm"
                onClick={handleSkip}
                className="h-auto rounded-full px-3 py-1.5 text-[14px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors md:!no-underline md:hover:!no-underline"
                showRipple={false}
                aria-label="Skip identity checks"
              >
                Skip
              </Button>
            </div>
          </div>


          <div className="mx-auto flex w-full flex-col text-left">
            <div className="mb-8 space-y-3">
              <div className="flex items-center gap-3 text-primary">
                <span className="flex h-10 w-10 items-center justify-center rounded-[var(--app-radius-lg)] border border-border/60 bg-secondary/40">
                  <Brain className="h-5 w-5" />
                </span>
                <p className="text-sm font-semibold">Bring your profile with you</p>
              </div>
              <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Import from ChatGPT or another AI
              </h1>
              <p className="max-w-[34rem] text-[15px] leading-relaxed text-muted-foreground">
                Ask your other AI for an export, then paste its response here.
              </p>
            </div>

            <div className="space-y-6">
              <section aria-labelledby="copy-import-request" className="space-y-3">
                <h2 id="copy-import-request" className="text-sm font-semibold text-foreground">
                  1. Copy this request
                </h2>
                <div className="relative rounded-[var(--app-radius-lg)] border border-border/60 bg-secondary/25 p-4 pr-14 text-[13px] leading-relaxed text-foreground">
                  {EXTERNAL_PROFILE_EXPORT_PROMPT}
                  <button
                    type="button"
                    onClick={copyPrompt}
                    className="absolute right-1.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-150 hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20"
                    aria-label="Copy import request"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </section>

              <section aria-labelledby="paste-profile-export" className="space-y-3">
                <h2 id="paste-profile-export" className="text-sm font-semibold text-foreground">
                  2. Paste the response
                </h2>
                <Textarea
                  value={aboutMe}
                  onChange={(event) => setAboutMe(event.target.value)}
                  placeholder="Paste the profile export from ChatGPT, Claude, or another AI."
                  className="min-h-[160px] resize-none border-input/60 bg-background p-5 text-[15px] leading-relaxed shadow-sm transition-[border-color,box-shadow] duration-150 focus-visible:border-primary/40 focus-visible:ring-[4px] focus-visible:ring-primary/20"
                  aria-label="Paste your profile export"
                  disabled={isSaveStarted}
                />
              </section>
              {/* Stated, not extracted. A pasted export is another assistant's
                  prose; these three are the person's own answer, and each is
                  optional so a blank one stays absent rather than guessed. */}
              <section aria-labelledby="stated-identity" className="space-y-3">
                <h2 id="stated-identity" className="text-sm font-semibold text-foreground">
                  3. Your details (optional)
                </h2>
                <div className="space-y-2">
                  <Label htmlFor="kyc-legal-name">Legal name</Label>
                  <Input
                    id="kyc-legal-name"
                    value={legalName}
                    onChange={(event) => setLegalName(event.target.value)}
                    disabled={isSaveStarted}
                    autoComplete="name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kyc-date-of-birth">Date of birth</Label>
                  <Input
                    id="kyc-date-of-birth"
                    type="date"
                    value={dateOfBirth}
                    onChange={(event) => setDateOfBirth(event.target.value)}
                    disabled={isSaveStarted}
                    aria-invalid={!dateOfBirthValid}
                    aria-describedby="kyc-date-of-birth-help"
                  />
                  <p id="kyc-date-of-birth-help" className="text-xs text-muted-foreground">
                    {dateOfBirthValid
                      ? "Your age is worked out from this. The date itself is never shared."
                      : "Enter a real past date."}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kyc-sex">Sex</Label>
                  <Input
                    id="kyc-sex"
                    value={sex}
                    onChange={(event) => setSex(event.target.value)}
                    disabled={isSaveStarted}
                    aria-describedby="kyc-sex-help"
                  />
                  <p id="kyc-sex-help" className="text-xs text-muted-foreground">
                    Recorded only as you write it, and never guessed from
                    anything else.
                  </p>
                </div>
              </section>
            </div>

            <div className="mx-auto w-full pt-8 sm:w-80">
              <Button
                type="button"
                variant="none"
                effect="fill"
                size="lg"
                fullWidth
                onClick={handlePrimary}
                disabled={!canContinue || isSaveStarted}
                showRipple
                className={cn(
                  "h-14 rounded-full text-base font-semibold shadow-sm",
                  "transition-[background-color,color,transform] duration-150 ease-out",
                  canContinue && !isSaveStarted
                    ? "!bg-foreground !text-background hover:opacity-90"
                    : "!bg-secondary !text-muted-foreground",
                )}
              >
                Import & Continue
              </Button>
            </div>
          </div>
        </div>
      </div>
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          onSuccess={() => {
            setVaultDialogOpen(false);
            toast.success("Your vault is ready. Import your profile to continue.");
          }}
          title="Set up your private vault"
          description="Create or unlock your vault before importing your profile."
          allowVaultCreation
        />
      ) : null}
    </CapabilityCinematicIntroGate>
  );
}
