"use client";

import { Loader2, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import type { PkmUpgradeStatus } from "@/lib/services/pkm-upgrade-service";

function humanizeDomain(domain: string): string {
  return String(domain || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

type Props = {
  status: PkmUpgradeStatus | null;
  loading?: boolean;
  onResume?: () => void;
  resumeBusy?: boolean;
  onUnlock?: () => void;
  vaultUnlocked?: boolean;
  showRecoveryAction?: boolean;
};

export function PkmUpgradeStatusCard({
  status,
  loading = false,
  onResume,
  resumeBusy = false,
  onUnlock,
  vaultUnlocked = false,
  showRecoveryAction = false,
}: Props) {
  const run = status?.run ?? null;
  const isRecoverable = status?.upgradeStatus === "failed";
  const showResume = Boolean(status && isRecoverable && showRecoveryAction && onResume);
  const upgradableDomains = status?.upgradableDomains || [];
  const hasCurrentTruth = status?.upgradeStatus === "current" && upgradableDomains.length === 0;
  const showCurrentDomain = Boolean(run?.currentDomain && !hasCurrentTruth);
  const showLatestIssue = Boolean(run?.lastError && !hasCurrentTruth);
  const versionBadgeLabel = hasCurrentTruth
    ? "Current"
    : status?.upgradeStatus === "running"
      ? "Updating"
      : "Needs attention";

  return (
    <SurfaceInset className="rounded-[28px] border border-border/50 bg-background/85 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
            ) : status?.upgradeStatus === "current" ? (
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-amber-500" />
            )}
            <p className="text-sm font-semibold text-foreground">
              Personal data status
            </p>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {loading
              ? "Checking whether your saved details need an update."
              : status?.upgradeStatus === "current"
                ? "Your saved details are up to date."
                : status?.upgradeStatus === "awaiting_local_auth_resume"
                  ? "Unlock your vault to continue updating your saved details."
                  : status?.upgradeStatus === "running"
                    ? "Updating your saved details in the background while you keep using the app."
                    : status?.upgradeStatus === "failed"
                      ? "We paused while updating your saved details. You can try again below."
                      : "Refreshing your saved details in the background."}
          </p>
        </div>
        <Badge variant="secondary" className="rounded-full px-3 py-1">
          {versionBadgeLabel}
        </Badge>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(upgradableDomains.length > 0 ? upgradableDomains : []).slice(0, 4).map((domain) => (
          <Badge key={domain.domain} variant="outline" className="rounded-full px-3 py-1">
            {humanizeDomain(domain.domain)}
          </Badge>
        ))}
        {status && upgradableDomains.length === 0 ? (
          <Badge variant="outline" className="rounded-full px-3 py-1">
            No pending updates
          </Badge>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {showResume && vaultUnlocked ? (
          <Button
            type="button"
            variant="none"
            size="sm"
            onClick={onResume}
            disabled={resumeBusy}
          >
            {resumeBusy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Retry update
          </Button>
        ) : null}
        {showResume && !vaultUnlocked && onUnlock ? (
          <Button type="button" variant="none" size="sm" onClick={onUnlock}>
            Unlock to retry
          </Button>
        ) : null}
        {showCurrentDomain ? (
          <p className="text-xs text-muted-foreground">
            Updating {humanizeDomain(run?.currentDomain || "")}
          </p>
        ) : null}
        {status?.lastUpgradedAt ? (
          <p className="text-xs text-muted-foreground">
            Last updated: {new Date(status.lastUpgradedAt).toLocaleString()}
          </p>
        ) : null}
      </div>
      {showLatestIssue ? (
        <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/5 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-600/90">
            Update paused
          </p>
          <p className="mt-1 text-sm text-foreground">
            We could not finish updating your saved details. Try again after unlocking your vault.
          </p>
        </div>
      ) : null}
    </SurfaceInset>
  );
}
