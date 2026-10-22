"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldCheck } from "@/components/icons";
import { toast } from "sonner";

import { withDeadline } from "@/lib/utils/with-deadline";
import { useMailKycIntake } from "@/lib/gmail/use-mail-kyc-intake";
import { KycPasteDetailsDialog } from "@/components/gmail/kyc-paste-details-dialog";
import { KycProfileHero } from "@/components/gmail/kyc-profile-hero";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Skeleton } from "@/components/ui/skeleton";
import { MailActionButton as Button } from "./mail-action-button";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";
import { copyToClipboard } from "@/lib/utils/clipboard";

const EXTERNAL_AGENT_PROMPT =
  "Summarize my personal and KYC details as simple Markdown bullet points under Facts, Preferences, and Commitments. Note anything uncertain or missing. Do not include passwords, PINs, security codes, or authentication keys.";

type GmailVerificationOnboardingProps = {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  onRequestVaultUnlock: () => void;
  deferred: boolean;
  onDeferredChange: (deferred: boolean) => void;
  details: string;
  onDetailsChange: (details: string) => void;
  children: ReactNode;
};

export function GmailVerificationOnboarding(props: GmailVerificationOnboardingProps) {
  const authority = [props.userId, props.vaultKey, Boolean(props.vaultOwnerToken)] as const;
  const [scope, setScope] = useState({ authority, generation: 0 });
  if (authority.some((value, index) => value !== scope.authority[index])) {
    setScope({ authority, generation: scope.generation + 1 });
  }
  return <GmailVerificationOnboardingSession key={scope.generation} {...props} />;
}

function GmailVerificationOnboardingSession({
  userId,
  vaultKey,
  vaultOwnerToken,
  onRequestVaultUnlock,
  deferred,
  onDeferredChange,
  details,
  onDetailsChange,
  children,
}: GmailVerificationOnboardingProps) {
  const currentSessionRef = useRef(true);
  useEffect(() => { currentSessionRef.current = true; return () => { currentSessionRef.current = false; }; }, []);
  const intake = useMailKycIntake({ userId, vaultKey, vaultOwnerToken });
  const [lastIntake, setLastIntake] = useState(intake.data);
  if (intake.data !== null && intake.data !== lastIntake) setLastIntake(intake.data);
  const knownIntake = intake.data ?? lastIntake;
  const [approvedIntake, setProfileReady] = useState(false);
  const profileReady = approvedIntake || knownIntake === true || intake.error !== null;
  const checking = knownIntake === null && intake.loading;
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const saveStartedRef = useRef(false);

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
    const saveTask = withDeadline(KycIdentityProfilePkmService.saveProfile({
      userId,
      vaultKey,
      vaultOwnerToken,
      profile: { aboutMe },
    }), Date.now() + 120_000);

    // The person has explicitly approved this import. Continue into the KYC
    // workspace immediately while the encrypted PKM write completes without
    // holding their navigation hostage.
    setProfileReady(true);
    setPasteOpen(false);
    onDetailsChange("");
    toast.info("Saving your KYC details privately in the background…");
    void saveTask
      .then((result) => {
        if (!currentSessionRef.current) return;
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
        intake.markCompleted();
        toast.success(result.message || "KYC details saved privately.");
      })
      .catch((error: unknown) => {
        if (!currentSessionRef.current) return;
        console.error("[PKM_INGEST] kyc_background_save_failed", {
          source: "kyc_identity_onboarding",
          error_code: "background_task_rejected",
        });
        toast.error(error instanceof Error && error.name === "TimeoutError"
          ? "We couldn’t confirm your save. Check Memory before trying again."
          : "We couldn't save your KYC details to Memory. Nothing new was added.");
      })
      .finally(() => { if (currentSessionRef.current) setSaving(false); });
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
