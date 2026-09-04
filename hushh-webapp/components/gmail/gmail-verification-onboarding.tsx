"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/button";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import {
  isKycIdentityPrefaceComplete,
  KycIdentityProfilePkmService,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { copyToClipboard } from "@/lib/utils/clipboard";

const EXTERNAL_AGENT_PROMPT =
  "Create a concise, reviewable summary of the personal and KYC details I have explicitly provided to you. Include only information useful for KYC, organized by field.";

export function GmailVerificationOnboarding({
  userId,
  vaultKey,
  vaultOwnerToken,
  onRequestVaultUnlock,
  deferred,
  onDeferredChange,
  details,
  onDetailsChange,
  children,
}: {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  onRequestVaultUnlock: () => void;
  deferred: boolean;
  onDeferredChange: (deferred: boolean) => void;
  details: string;
  onDetailsChange: (details: string) => void;
  children: ReactNode;
}) {
  const [profileReady, setProfileReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setChecking(true);
    setProfileReady(false);
    if (!userId || !vaultKey || !vaultOwnerToken) {
      setChecking(false);
      return;
    }

    let cancelled = false;
    void PkmDomainResourceService.getStaleFirst({
      userId,
      domain: "identity",
      vaultKey,
      vaultOwnerToken,
    })
      .then((snapshot) => {
        const profile = snapshot?.data?.identity_profile;
        if (!cancelled && isKycIdentityPrefaceComplete(profile)) {
          setProfileReady(true);
        }
      })
      .catch(() => {
        // An unreadable snapshot is not evidence that setup is incomplete.
        if (!cancelled) setProfileReady(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, vaultKey, vaultOwnerToken]);

  const copyPrompt = async () => {
    if (!(await copyToClipboard(EXTERNAL_AGENT_PROMPT))) {
      toast.error("We couldn't copy that prompt. Select and copy it instead.");
      return;
    }
    setCopied(true);
    toast.success("Prompt copied.");
    window.setTimeout(() => setCopied(false), 2_000);
  };

  const save = async () => {
    if (!userId || !vaultKey || !vaultOwnerToken || !details.trim()) return;
    setSaving(true);
    try {
      const result = await KycIdentityProfilePkmService.saveProfile({
        userId,
        vaultKey,
        vaultOwnerToken,
        profile: { aboutMe: details.trim() },
      });
      if (!result.success) {
        throw new Error(result.message || "We couldn't save those details.");
      }
      setProfileReady(true);
      onDetailsChange("");
      toast.success("KYC details saved privately.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "We couldn't save those details.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (checking) {
    return (
      <SurfaceInset
        aria-busy="true"
        aria-live="polite"
        aria-label="Checking KYC setup"
        className="space-y-3 px-4 py-5 sm:px-5"
      >
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      </SurfaceInset>
    );
  }
  if (profileReady || deferred) return <>{children}</>;

  if (!vaultKey || !vaultOwnerToken) {
    return (
      <SurfaceInset className="space-y-3 px-4 py-5 sm:px-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">
              Set up KYC
            </h2>
            <p className="text-sm text-muted-foreground">
              Open your private vault before importing details for future KYC
              replies.
            </p>
          </div>
        </div>
        <Button type="button" onClick={onRequestVaultUnlock}>
          Open private vault
        </Button>
      </SurfaceInset>
    );
  }

  return (
    <SurfaceInset className="space-y-4 px-4 py-5 sm:px-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Build your KYC profile
        </h2>
        <p className="text-sm text-muted-foreground">
          Ask another AI for an export, paste it here, then save only the
          details you want One to use for future KYC replies.
        </p>
      </div>
      <Textarea
        value={details}
        onChange={(event) => onDetailsChange(event.target.value)}
        placeholder="Paste the KYC details you want to save privately. You can edit this before saving."
        className="min-h-36 resize-y"
        aria-label="KYC details"
        disabled={saving}
      />
      <div className="rounded-xl border border-border/60 bg-background/60 p-3">
        <p className="text-sm font-medium text-foreground">
          Import from another AI
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Copy this prompt into ChatGPT, Claude, or another agent. Then paste
          the export above and review it before saving.
        </p>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2">
          <p className="text-xs leading-5 text-muted-foreground">
            {EXTERNAL_AGENT_PROMPT}
          </p>
          <Button
            type="button"
            size="icon"
            variant="muted"
            onClick={() => void copyPrompt()}
            aria-label="Copy KYC export prompt"
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => void save()}
          disabled={saving || !details.trim()}
        >
          {saving ? "Saving…" : "Save KYC details"}
        </Button>
        <Button
          type="button"
          variant="muted"
          onClick={() => onDeferredChange(true)}
          disabled={saving}
        >
          Skip for now
        </Button>
      </div>
    </SurfaceInset>
  );
}
