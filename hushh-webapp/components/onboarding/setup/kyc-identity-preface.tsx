"use client";

import { useState } from "react";
import { Brain, Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { MorphyTextarea } from "@/lib/morphy-ux/textarea";
import {
  KycIdentityProfileDraftService,
  type KycIdentityProfile,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { cn } from "@/lib/utils";

export function KycIdentityPreface({ onComplete }: { onComplete: () => void }) {
  const { user } = useAuth();
  const [aboutMe, setAboutMe] = useState("");
  const [copied, setCopied] = useState(false);

  const canContinue = aboutMe.trim().length > 5;

  const handlePrimary = () => {
    if (!canContinue) return;
    if (!user?.uid) {
      toast.error("Sign in before saving your details.");
      return;
    }

    const profile: KycIdentityProfile = {
      aboutMe: aboutMe.trim(),
    };

    // Capability setup is deliberately vault-free. Keep the sensitive draft
    // only in process memory; the root Finish setup action is the one place
    // that introduces the vault and flushes this profile after unlock.
    KycIdentityProfileDraftService.stage(user.uid, profile);
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
      <div className="mx-auto flex min-h-0 w-full max-w-[32rem] my-auto flex-col justify-center px-4 py-3">
        <div className="w-full space-y-4">
          {/* Symmetric Top Action Bar */}
          <div className="flex h-10 w-full items-center justify-between gap-4">
            <span className="type-subhead text-muted-foreground/80 font-medium">
              One · KYC
            </span>
            <Button
              type="button"
              variant="link"
              effect="fade"
              size="sm"
              onClick={handleSkip}
              className="h-9 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground active:scale-95"
              showRipple={false}
              aria-label="Skip KYC setup"
            >
              Skip
            </Button>
          </div>

          <div className="mx-auto flex w-full flex-col space-y-4">
            {/* Header Section */}
            <div className="space-y-1.5 text-left">
              <p className="type-subhead text-muted-foreground">
                Build your private personal identity
              </p>
              <h1 className="type-title1 text-balance text-foreground font-semibold tracking-tight">
                Tell us about yourself
              </h1>
            </div>

            {/* Input Section */}
            <div>
              <MorphyTextarea
                value={aboutMe}
                onChange={(event) => setAboutMe(event.target.value)}
                placeholder="Share details about your professional background, interests, residency, or other details. Only you and One can see this, and it stays entirely inside your private vault."
                className="min-h-[110px]"
                aria-label="Tell us about yourself"
              />
            </div>

            {/* External Agents Import Helper (Morphy Compact Card) */}
            <div className="rounded-2xl border border-border/60 bg-[color:var(--app-card-surface-compact)] p-4 space-y-3 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-primary/10 rounded-xl text-primary shrink-0">
                  <Brain className="h-4 w-4" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    Import from ChatGPT or Claude
                  </h3>
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    Already have an active profile with another AI? Copy the prompt below to ask them to export your data, then paste it above.
                  </p>
                </div>
              </div>

              <div className="relative rounded-xl border border-input/50 bg-background/60 p-3 pr-10 text-[12px] leading-relaxed text-foreground select-all dark:bg-input/10">
                "I want to transfer all my personal information about myself to another ai agent, can you tell in detail all the data you have stored within me."
                <button
                  type="button"
                  onClick={copyPrompt}
                  className="absolute right-2 top-2.5 p-1.5 hover:bg-muted/80 rounded-lg text-muted-foreground hover:text-foreground transition-colors active:scale-95"
                  title="Copy export prompt"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Action Primary CTA */}
            <div className="pt-2">
              <Button
                type="button"
                variant={canContinue ? "blue-gradient" : "none"}
                effect="fill"
                size="lg"
                fullWidth
                onClick={handlePrimary}
                disabled={!canContinue}
                showRipple={canContinue}
                className={cn(
                  "h-12 rounded-full font-semibold transition-all",
                  canContinue
                    ? "shadow-md shadow-blue-500/15"
                    : "!bg-muted !text-muted-foreground/60 cursor-not-allowed opacity-60 shadow-none",
                )}
              >
                Save & Continue
              </Button>
            </div>
          </div>
        </div>
      </div>
    </CapabilityCinematicIntroGate>
  );
}
