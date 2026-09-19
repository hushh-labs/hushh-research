"use client";

import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useOnboardingDismissStore } from "@/lib/stores/onboarding-dismiss-store";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

export interface CapabilityDismissTarget {
  id: string;
  title: string;
}

/**
 * The dismiss confirm opened from a capability row's trailing "x". "Remember
 * my choice" decides how long the dismiss lasts:
 *  - checked: the same durable write today's decline already uses
 *    (`setup_capability_declined_ids`, full-array replace) -- permanent
 *    until the person opens that capability's own page on purpose.
 *  - unchecked: a session-only dismiss in the Zustand store, gone on next
 *    load. Deliberately does not schedule any later re-ask -- that needs
 *    real notification infrastructure and is out of scope here.
 */
export function CapabilityDismissDialog({
  target,
  userId,
  currentDeclinedIds,
  onOpenChange,
  onPermanentDismiss,
}: {
  target: CapabilityDismissTarget | null;
  userId: string | null | undefined;
  /** The full current declined-ids set, so a permanent write can merge into it. */
  currentDeclinedIds: readonly string[];
  onOpenChange: (open: boolean) => void;
  /** Called with the new full declined-ids array after a permanent (remembered) dismiss commits. */
  onPermanentDismiss: (nextDeclinedIds: string[]) => void;
}) {
  const [rememberChoice, setRememberChoice] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissForSession = useOnboardingDismissStore(
    (state) => state.dismissForSession,
  );

  const handleConfirm = async () => {
    if (!target) return;
    setError(null);
    // No signed-in user to durably attribute a "remembered" decline to --
    // this screen is auth-gated so this should not happen in practice, but
    // degrade to a session-only dismiss rather than silently doing nothing.
    if (rememberChoice && !userId) {
      dismissForSession(target.id);
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    try {
      if (rememberChoice && userId) {
        const next = Array.from(new Set([...currentDeclinedIds, target.id]));
        await PreVaultUserStateService.syncDeclinedCapabilities(userId, next);
        onPermanentDismiss(next);
      } else {
        dismissForSession(target.id);
      }
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to dismiss that right now.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target ? `Not set up ${target.title}?` : "Not set up?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            One won&apos;t ask about this again unless you open it yourself.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2.5 px-1 py-2 text-sm text-foreground">
          <Checkbox
            checked={rememberChoice}
            onCheckedChange={(checked) => setRememberChoice(checked === true)}
          />
          Remember my choice
        </label>
        <p className="px-1 text-xs text-muted-foreground">
          {rememberChoice
            ? "Stays dismissed everywhere until you open it yourself."
            : "Dismissed for now -- may ask again later, this device only."}
        </p>
        {error ? (
          <p className="px-1 text-xs text-[color:var(--app-destructive)]">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {submitting ? "Dismissing…" : "Dismiss"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
