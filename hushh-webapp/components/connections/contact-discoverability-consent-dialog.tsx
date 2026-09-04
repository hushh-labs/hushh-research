"use client";

import { Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ContactDiscoverabilityConsentDialogProps } from "@/lib/contacts/use-contact-discoverability-consent";

export function ContactDiscoverabilityConsentDialog({
  open,
  ready,
  loading,
  savingChoice,
  error,
  actionLabel,
  onOpenChange,
  onChoose,
  onRetry,
}: ContactDiscoverabilityConsentDialogProps) {
  const saving = savingChoice !== null;

  return (
    <Dialog modal open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-5 sm:max-w-md"
        showCloseButton={!saving}
        srDescription="Choose whether verified people who have your verified phone number may find and automatically connect with you."
      >
        <DialogHeader className="pr-8 text-left">
          <span className="flex h-11 w-11 items-center justify-center rounded-[var(--app-radius-lg)] bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <DialogTitle>Choose your contact privacy</DialogTitle>
          <p className="text-muted-foreground text-sm leading-5">
            Allow verified people who already have your verified phone number to
            find and automatically connect with you, or keep your profile
            private from contact matching.
          </p>
        </DialogHeader>

        {loading ? (
          <div
            className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking your current choice...
          </div>
        ) : error && !ready ? (
          <div className="space-y-3">
            <p
              className="rounded-[var(--app-radius-lg)] bg-[color:var(--app-neutral-fill)] px-4 py-3 text-sm text-foreground"
              role="alert"
            >
              {error}
            </p>
            <Button type="button" className="w-full" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {error ? (
              <p
                className="rounded-[var(--app-radius-lg)] bg-[color:var(--app-neutral-fill)] px-4 py-3 text-sm text-foreground"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <DialogFooter className="flex-col-reverse sm:flex-col-reverse">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                isLoading={savingChoice === false}
                onClick={() => void onChoose(false)}
              >
                Keep private
              </Button>
              <Button
                type="button"
                disabled={saving}
                isLoading={savingChoice === true}
                onClick={() => void onChoose(true)}
              >
                Allow contact matching
              </Button>
            </DialogFooter>
            <p className="text-center text-xs leading-5 text-muted-foreground">
              After saving, tap {actionLabel} again to choose which contacts to
              check.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
