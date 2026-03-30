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
  const isRecoverable = status?.upgradeStatus === "failed";
  const showResume = Boolean(status && isRecoverable && showRecoveryAction && onResume);
  const upgradableDomains = status?.upgradableDomains || [];

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
              Personal Knowledge Model Status
            </p>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {loading
              ? "Checking whether Kai needs to refresh your encrypted Personal Knowledge Model."
              : status?.upgradeStatus === "current"
                ? "Your Personal Knowledge Model is current. Kai is using the latest encrypted structure for your saved memories."
                : status?.upgradeStatus === "awaiting_local_auth_resume"
                  ? "Kai is waiting for the next local vault unlock so the PKM refresh can resume automatically."
                  : status?.upgradeStatus === "running"
                    ? "Kai is refreshing your encrypted Personal Knowledge Model in the background while you keep using the app."
                    : status?.upgradeStatus === "failed"
                      ? "Kai hit a recovery state while refreshing your encrypted Personal Knowledge Model. Advanced recovery controls stay below."
                      : "Kai found an older PKM shape and is refreshing it in the background without exposing your plaintext data to the server."}
          </p>
        </div>
        <Badge variant="secondary" className="rounded-full px-3 py-1">
          v{status?.modelVersion ?? "?"} / v{status?.targetModelVersion ?? "?"}
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
            No pending domain upgrades
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
            Resume upgrade
          </Button>
        ) : null}
        {showResume && !vaultUnlocked && onUnlock ? (
          <Button type="button" variant="none" size="sm" onClick={onUnlock}>
            Unlock to retry
          </Button>
        ) : null}
        {status?.run?.currentDomain ? (
          <p className="text-xs text-muted-foreground">
            Current domain: {humanizeDomain(status.run.currentDomain)}
          </p>
        ) : null}
        {status?.lastUpgradedAt ? (
          <p className="text-xs text-muted-foreground">
            Last completed upgrade: {new Date(status.lastUpgradedAt).toLocaleString()}
          </p>
        ) : null}
      </div>
    </SurfaceInset>
  );
}
