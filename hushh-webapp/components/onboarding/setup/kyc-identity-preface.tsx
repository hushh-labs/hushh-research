"use client";

import { useRef, useState } from "react";
import { Brain, Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { type KycIdentityProfile } from "@/lib/services/kyc-identity-profile-pkm-service";
import { cn } from "@/lib/utils";

import { useVault } from "@/lib/vault/vault-context";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";

export function KycIdentityPreface({ onComplete }: { onComplete: () => void }) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [aboutMe, setAboutMe] = useState("");
  const [copied, setCopied] = useState(false);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [isSaveStarted, setIsSaveStarted] = useState(false);
  const saveStartedRef = useRef(false);

  const canContinue = aboutMe.trim().length > 5;

  const handlePrimary = async () => {
    if (!canContinue || saveStartedRef.current) return;
    if (!user?.uid) {
      toast.error("Sign in before saving your details.");
      return;
    }

    const profile: KycIdentityProfile = {
      aboutMe: aboutMe.trim(),
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
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
      profile,
    });
    onComplete();
    toast.info("Saving your details to Memory in the background…");
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
    const promptText =
      "I want to transfer all my personal information about myself to another ai agent, can you tell in detail all the data you have stored within me.";
    navigator.clipboard.writeText(promptText);
    toast.success("Prompt copied to clipboard!");
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


          <div className="mx-auto flex w-full flex-col text-center">
            <div className="space-y-2 mb-8">
              <p className="text-sm font-medium uppercase tracking-widest text-primary/80">
                Identity
              </p>
              <h1 className="text-3xl sm:text-4xl text-balance text-foreground font-semibold tracking-tight">
                Tell us about yourself
              </h1>
            </div>

            <div className="text-left w-full relative">
              <Textarea
                value={aboutMe}
                onChange={(event) => setAboutMe(event.target.value)}
                placeholder="Share details about your professional background, interests, residency, or other details. We’ll organize them into separate encrypted memories in your private vault."
                className="min-h-[140px] rounded-2xl p-5 text-[15px] leading-relaxed resize-none bg-background shadow-sm border border-input/60 focus-visible:ring-primary/20 focus-visible:ring-[4px] focus-visible:border-primary/40 transition-all"
                aria-label="Tell us about yourself"
                disabled={isSaveStarted}
              />
            </div>

            {/* External Agents Import Helper */}
            <div className="mt-6 text-left rounded-3xl border border-border/40 bg-secondary/20 p-5 space-y-4 shadow-sm relative overflow-hidden">
              <div className="absolute top-0 right-0 -mr-4 -mt-4 opacity-5 pointer-events-none">
                <Brain className="w-32 h-32" />
              </div>
              <div className="flex items-start gap-4 relative z-10">
                <div className="p-2.5 bg-background shadow-sm rounded-xl text-primary shrink-0 border border-border/50">
                  <Brain className="h-5 w-5" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-sm font-semibold text-foreground">
                    Import from ChatGPT or Claude
                  </h3>
                  <p className="text-[13px] leading-relaxed text-muted-foreground max-w-[95%]">
                    Already have an active profile with another AI? Copy the
                    prompt below to ask them to export your data, then paste it
                    above.
                  </p>
                </div>
              </div>

              <div className="relative rounded-2xl border border-border/50 bg-background/80 backdrop-blur-sm p-4 pr-12 text-[13px] leading-relaxed text-foreground select-all shadow-sm transition-colors hover:border-border/80">
                "I want to transfer all my personal information about myself to
                another ai agent, can you tell in detail all the data you have
                stored within me."
                <button
                  type="button"
                  onClick={copyPrompt}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 hover:bg-muted rounded-xl text-muted-foreground hover:text-foreground transition-all active:scale-95"
                  title="Copy export prompt"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="pt-8">
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
                  "transition-all duration-200 ease-out active:scale-[0.98]",
                  canContinue && !isSaveStarted
                    ? "!bg-foreground !text-background hover:opacity-90"
                    : "!bg-secondary !text-muted-foreground",
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
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          onSuccess={() => {
            setVaultDialogOpen(false);
            toast.success("Your vault is ready. Save your details to continue.");
          }}
          title="Set up your private vault"
          description="Create or unlock your vault before saving identity details."
          allowVaultCreation
        />
      ) : null}
    </CapabilityCinematicIntroGate>
  );
}
