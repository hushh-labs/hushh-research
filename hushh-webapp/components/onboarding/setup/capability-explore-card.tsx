"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/lib/firebase/auth-context";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { CapabilityTourService } from "@/lib/services/capability-tour-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * CapabilityExploreCard — a one-time, first-visit intro for an explore-only
 * capability (a tab that collects nothing). It explains what lives in the tab
 * ("no setup required, just explore"); dismissing it once marks the capability
 * Explored, which is how an explore-only capability completes its setup.
 *
 * Mount this near the top of each explore-only tab (email, location, consent).
 * It self-gates: it only renders for explore-only capabilities the current user
 * has NOT explored yet, and it never blocks the page — the tab is fully usable
 * behind it.
 *
 * Persistence mirrors the rest of the setup pipeline: the local store
 * (CapabilityTourService) is the source of truth; the backend mirror is a
 * best-effort, cross-device echo.
 */
export interface CapabilityExploreCardProps {
  /** Catalog id of the explore-only capability this tab represents. */
  capabilityId: string;
  /** Optional hook for callers that want to refresh derived state on explore. */
  onExplored?: () => void;
}

export function CapabilityExploreCard({
  capabilityId,
  onExplored,
}: CapabilityExploreCardProps) {
  const { user } = useAuth();
  const userId = user?.uid ?? null;

  const capability = getOneCapability(capabilityId);
  const copy = getCapabilitySetupCopy(capabilityId);
  const isExploreOnly = capability?.isExploreOnly === true;

  // null = still resolving; true/false = whether to show the card.
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!userId || !isExploreOnly) {
      setResolved(true);
      setOpen(false);
      return;
    }
    let cancelled = false;
    CapabilityTourService.loadExploredIds(userId)
      .then((ids) => {
        if (cancelled) return;
        setOpen(!ids.includes(capabilityId));
        setResolved(true);
      })
      .catch(() => {
        // On a read failure, do not nag: assume explored so we never trap the
        // user behind a card we cannot resolve.
        if (cancelled) return;
        setOpen(false);
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, capabilityId, isExploreOnly]);

  if (!userId || !isExploreOnly || !copy || !resolved) {
    return null;
  }

  const title = copy.exploreTitle ?? copy.setupTitle;
  const blurb = copy.exploreBlurb ?? copy.setupBlurb;
  const bullets = copy.exploreBullets ?? [];

  const handleExplored = () => {
    setOpen(false);
    // Local store is the source of truth; persist, then best-effort mirror.
    void CapabilityTourService.markExplored(userId, capabilityId)
      .then((state) =>
        PreVaultUserStateService.syncSetupCapabilities(
          userId,
          state.exploredIds,
        ).catch(() => {
          // local copy already recorded the exploration
        }),
      )
      .catch(() => {
        // never block the tab on a persistence failure
      });
    onExplored?.();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Any dismissal (button, overlay, escape) counts as having explored.
        if (!next) handleExplored();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{blurb}</DialogDescription>
        </DialogHeader>
        {bullets.length > 0 && (
          <ul className="space-y-2 text-sm text-muted-foreground">
            {bullets.map((bullet) => (
              <li key={bullet} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40"
                />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" onClick={handleExplored} className="w-full sm:w-auto">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
