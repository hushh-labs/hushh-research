"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ShieldCheck } from "@/components/icons";
import { toast } from "sonner";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
      toast.error("We couldn't copy that prompt. Select and copy it instead.");
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
        className="space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5 min-h-[340px]"
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
      <SurfaceInset className="space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Set up KYC
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
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
    <SurfaceInset className="space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Build your KYC profile
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Paste your profile details to automate future KYC responses.
        </p>
      </div>
      <Textarea
        value={details}
        onChange={(event) => onDetailsChange(event.target.value)}
        placeholder="Paste your KYC details here…"
        className="min-h-32 resize-y text-sm"
        aria-label="KYC details"
        disabled={saving}
      />
      <div className="rounded-xl border border-border/60 bg-background/60 p-3.5 space-y-3">
        <p className="text-xs font-semibold text-foreground">
          Import from another AI
        </p>
        <p className="text-xs text-muted-foreground">
          Copy this prompt into ChatGPT or Claude, then paste the output above.
        </p>
        <div
          role="button"
          tabIndex={0}
          onClick={() => void copyPrompt()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void copyPrompt();
            }
          }}
          aria-label="Copy prompt to clipboard"
          className="group relative flex cursor-pointer flex-col gap-2.5 rounded-xl border border-dashed border-border/80 bg-background p-4 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center rounded-md bg-indigo-500/10 px-2 py-0.5 text-[11px] font-bold tracking-wider text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-400">
              PROMPT
            </span>
            <div className="flex items-center gap-2">
              {copied ? (
                <span
                  aria-live="polite"
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 animate-in fade-in duration-200"
                >
                  ✓ Copied!
                </span>
              ) : null}
              <Button
                type="button"
                size="icon"
                variant="none"
                tabIndex={-1}
                aria-hidden="true"
                className="h-8 w-8 shrink-0 text-muted-foreground group-hover:text-foreground"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <p className="font-mono text-xs leading-relaxed text-foreground/90 select-all">
            {EXTERNAL_AGENT_PROMPT}
          </p>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
        <Button
          type="button"
          onClick={save}
          disabled={saving || !details.trim()}
          className="w-full sm:w-auto h-10 font-semibold rounded-full justify-center px-6"
        >
          {saving ? "Saving…" : "Save KYC profile"}
        </Button>
        <Button
          type="button"
          variant="muted"
          onClick={() => onDeferredChange(true)}
          disabled={saving}
          className="w-full sm:w-auto h-10 font-medium rounded-full justify-center px-6"
        >
          Skip
        </Button>
      </div>
    </SurfaceInset>
  );
}
