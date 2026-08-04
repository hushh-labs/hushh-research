"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Copy } from "lucide-react";
import { toast } from "sonner";

import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { Textarea } from "@/components/ui/textarea";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import {
  KycIdentityProfilePkmService,
  type KycIdentityProfile,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

export function KycIdentityPreface({ onComplete }: { onComplete: () => void }) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [aboutMe, setAboutMe] = useState("");
  const [copied, setCopied] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [profileAwaitingUnlock, setProfileAwaitingUnlock] =
    useState<KycIdentityProfile | null>(null);

  const canContinue = aboutMe.trim().length > 5;

  const saveProfileInBackground = useCallback(
    async (profile: KycIdentityProfile) => {
      if (!user?.uid || !vaultKey || !vaultOwnerToken) return;

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
        toast.success("Identity profile saved securely.");
      } catch {
        toast.error(
          "We couldn't save your identity details. Please try again.",
        );
      }
    },
    [user?.uid, vaultKey, vaultOwnerToken],
  );

  useEffect(() => {
    if (!profileAwaitingUnlock || !vaultKey || !vaultOwnerToken) return;

    const profile = profileAwaitingUnlock;
    setProfileAwaitingUnlock(null);
    setVaultOpen(false);
    void saveProfileInBackground(profile);
    onComplete();
  }, [
    onComplete,
    profileAwaitingUnlock,
    saveProfileInBackground,
    vaultKey,
    vaultOwnerToken,
  ]);

  const handlePrimary = () => {
    if (!canContinue) return;
    if (!user?.uid) {
      toast.error("Sign in before saving your details.");
      return;
    }

    const profile: KycIdentityProfile = {
      aboutMe: aboutMe.trim(),
    };
    if (!vaultKey || !vaultOwnerToken) {
      setProfileAwaitingUnlock(profile);
      setVaultOpen(true);
      return;
    }

    void saveProfileInBackground(profile);
    onComplete();
  };

  const handleSkip = () => {
    onComplete();
  };

  const copyPrompt = () => {
    const promptText =
      "I want to transfer all my personal information about myself to another ai agent, can you tell in detail all the data you have stored within me.";
    navigator.clipboard.writeText(promptText);
    toast.success("Prompt copied to clipboard!");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <CapabilityCinematicIntroGate capabilityId="email">
      <main
        data-top-content-anchor="true"
        className="flex h-[100dvh] w-full flex-col overflow-y-auto bg-transparent px-5 pb-[var(--app-screen-footer-pad)] pt-[var(--top-content-pad)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
      >
        <div className="mx-auto flex min-h-0 w-full max-w-[28rem] flex-1 flex-col justify-start pb-10 pt-2 sm:pt-4">
          <div className="w-full">
            <div className="space-y-2.5">
              <div className="flex min-h-8 items-center justify-between gap-3">
                <div className="w-4" />
                <Button
                  type="button"
                  variant="link"
                  effect="fade"
                  size="sm"
                  onClick={handleSkip}
                  className="h-8 rounded-full px-2.5 text-[14px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  showRipple={false}
                  aria-label="Skip KYC setup"
                >
                  Skip
                </Button>
              </div>
            </div>

            <div className="mx-auto flex w-full flex-col pt-6 sm:pt-8">
              <div className="space-y-2 text-left">
                <p className="type-subhead text-muted-foreground">
                  Build your private personal identity
                </p>
                <h1 className="type-title1 text-balance text-foreground font-semibold">
                  Tell us about yourself
                </h1>
              </div>

              <div className="mt-6">
                <Textarea
                  value={aboutMe}
                  onChange={(event) => setAboutMe(event.target.value)}
                  placeholder="Share details about your professional background, interests, residency, or other details. Only you and One can see this, and it stays entirely inside your private vault."
                  className="min-h-[140px] rounded-xl p-4 text-base leading-relaxed resize-none bg-background dark:bg-input/20 border-input focus-visible:ring-primary/40 focus-visible:ring-[3px]"
                  aria-label="Tell us about yourself"
                />
              </div>

              {/* External Agents Import Helper */}
              <div className="mt-6 rounded-2xl border border-border/80 bg-muted/30 p-4 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-primary/10 rounded-xl text-primary shrink-0">
                    <Brain className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                      Import from ChatGPT or Claude
                    </h3>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Already have an active profile with another AI? Copy the prompt below to ask them to export all your personal data, and paste their response above.
                    </p>
                  </div>
                </div>

                <div className="relative rounded-xl border border-input bg-background/50 p-3.5 pr-11 text-xs leading-relaxed text-foreground select-all dark:bg-input/10">
                  "I want to transfer all my personal information about myself to another ai agent, can you tell in detail all the data you have stored within me."
                  <button
                    type="button"
                    onClick={copyPrompt}
                    className="absolute right-2 top-2.5 p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                    title="Copy export prompt"
                  >
                    {copied ? (
                      <span className="text-[10px] font-medium text-emerald-600 block px-1">Copied</span>
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
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
                    "h-12 rounded-full type-headline font-semibold",
                    "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
                    "active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100",
                    canContinue
                      ? "!bg-primary !text-primary-foreground hover:!bg-primary/90"
                      : "!bg-muted !text-muted-foreground",
                  )}
                >
                  Save & Continue
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
            title="Unlock to continue"
            description="Enter your passphrase to save your personal details securely in your private vault."
            onSuccess={() => setVaultOpen(false)}
          />
        ) : null}
      </main>
    </CapabilityCinematicIntroGate>
  );
}
