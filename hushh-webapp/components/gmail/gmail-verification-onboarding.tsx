"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldCheck } from "@/components/icons";
import { toast } from "sonner";

import { KycPasteDetailsDialog } from "@/components/gmail/kyc-paste-details-dialog";
import { KycProfileHero } from "@/components/gmail/kyc-profile-hero";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/lib/morphy-ux/button";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import {
  hasCompletedKycIdentityIntake,
  KycIdentityProfilePkmService,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { copyToClipboard } from "@/lib/utils/clipboard";

const EXTERNAL_AGENT_PROMPT =
  "Summarize my personal and KYC details by field concisely for KYC.";

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
  const [pasteOpen, setPasteOpen] = useState(false);
  const saveStartedRef = useRef(false);

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
      // This is a one-time onboarding gate, not a list that can safely show
      // stale information. Refresh before deciding whether to ask again so a
      // completed background import never reopens this form on a later visit.
      forceRefresh: true,
      backgroundRefresh: false,
    })
      .then((snapshot) => {
        const profile = snapshot?.data?.identity_profile;
        if (!cancelled && hasCompletedKycIdentityIntake(profile)) {
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
      toast.error("Couldn't copy the prompt. Try again.");
      return;
    }
    setCopied(true);
    toast.success("Prompt copied.");
    window.setTimeout(() => setCopied(false), 2_000);
  };

  const save = () => {
    const aboutMe = details.trim();
    if (
      !userId ||
      !vaultKey ||
      !vaultOwnerToken ||
      !aboutMe ||
      saveStartedRef.current
    ) {
      return;
    }

    saveStartedRef.current = true;
    setSaving(true);
    const saveTask = KycIdentityProfilePkmService.saveProfile({
      userId,
      vaultKey,
      vaultOwnerToken,
      profile: { aboutMe },
    });

    // The person has explicitly approved this import. Continue into the KYC
    // workspace immediately while the encrypted PKM write completes without
    // holding their navigation hostage.
    setProfileReady(true);
    setPasteOpen(false);
    onDetailsChange("");
    toast.info("Saving your KYC details privately in the background…");
    void saveTask
      .then((result) => {
        if (!result.success) {
          console.error("[PKM_INGEST] kyc_background_save_failed", {
            source: "kyc_identity_onboarding",
            error_code: "save_incomplete",
          });
          toast.error(
            result.message || "We couldn't save your KYC details to Memory. Nothing new was added.",
          );
          return;
        }
        toast.success(result.message || "KYC details saved privately.");
      })
      .catch(() => {
        console.error("[PKM_INGEST] kyc_background_save_failed", {
          source: "kyc_identity_onboarding",
          error_code: "background_task_rejected",
        });
        toast.error("We couldn't save your KYC details to Memory. Nothing new was added.");
      })
      .finally(() => setSaving(false));
  };

  if (checking) {
    return (
      <SurfaceInset
        aria-busy="true"
        aria-live="polite"
        aria-label="Checking KYC setup"
        className="space-y-4 px-4 py-4 text-sm sm:px-5 sm:py-5"
      >
        <div className="space-y-1">
          <p className="font-semibold text-foreground">KYC requests</p>
          <p className="text-sm leading-6 text-muted-foreground">
            Getting your KYC workspace ready.
          </p>
        </div>
        <div aria-hidden="true" className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-[var(--app-card-radius-sm)] border border-border/60 bg-background/60 px-3.5 py-3">
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-52 max-w-full" />
            </div>
            <Skeleton className="h-10 w-24 shrink-0" />
          </div>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-24 w-full" />
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
            <p className="text-xs text-muted-foreground">
              Open your private vault before importing details for future KYC
              replies.
            </p>
          </div>
        </div>
        <Button type="button" onClick={onRequestVaultUnlock} className="w-full justify-center h-10 font-semibold rounded-full">
          Open private vault
        </Button>
      </SurfaceInset>
    );
  }

  return (
    <>
      <KycProfileHero onPasteDetails={() => setPasteOpen(true)} />
      <KycPasteDetailsDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        details={details}
        onDetailsChange={onDetailsChange}
        saving={saving}
        copied={copied}
        onCopyPrompt={() => void copyPrompt()}
        onSave={save}
        onSkip={() => {
          setPasteOpen(false);
          onDeferredChange(true);
        }}
      />
    </>
  );
}
