"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  canManagePodBackgroundConfig,
  readPodBackgroundConfig,
  setPodSessionOnlyLockdown,
} from "@/lib/services/pod-background-config";

export function PodSessionLockdownControl({
  testId = "pod-session-only-lockdown",
}: {
  testId?: string;
}) {
  const [available, setAvailable] = useState(false);
  const [lockedDown, setLockedDown] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canManagePodBackgroundConfig()) {
      setAvailable(false);
      return;
    }
    const owner = snapshotValidatedAuthSessionOwner();
    const controller = new AbortController();
    const isCurrent = () =>
      !controller.signal.aborted &&
      (!owner || isValidatedAuthSessionOwnerCurrent(owner));

    void readPodBackgroundConfig({ signal: controller.signal, isCurrent })
      .then((cfg) => {
        if (!isCurrent() || !cfg) return;
        setLockedDown(cfg.sessionOnlyLockdown);
        setAvailable(true);
      })
      .catch(() => {
        // Silent fallback when pod session is not yet open.
      });

    return () => controller.abort();
  }, []);

  if (!available) return null;

  const toggle = async (next: boolean) => {
    if (busy) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isCurrent = () => !owner || isValidatedAuthSessionOwnerCurrent(owner);
    if (!isCurrent()) return;

    setBusy(true);
    try {
      const updated = await setPodSessionOnlyLockdown(next, { isCurrent });
      if (isCurrent()) {
        setLockedDown(updated.sessionOnlyLockdown);
      }
    } catch {
      if (isCurrent()) {
        morphyToast.error("Could not update background wake settings. Try again.");
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-background p-3"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-semibold text-foreground">Session-only lockdown</p>
        <p className="text-xs text-[var(--app-text-secondary)]">
          {lockedDown
            ? "Paused · One runs only while your app is open."
            : "Off · One quietly prepares drafts and memory updates while you are away."}
        </p>
      </div>
      <Switch
        aria-label="Session-only lockdown"
        checked={lockedDown}
        disabled={busy}
        onCheckedChange={(checked) => void toggle(checked)}
      />
    </div>
  );
}
