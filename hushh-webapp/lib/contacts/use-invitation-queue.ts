"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  InviteCandidate,
  InviteDestination,
} from "./invitation-candidates";
import { personalizeInvitation } from "./personalize-invitation";
import {
  ContactInvitationsService,
  type InvitationOutcome,
  type InvitationShare,
} from "@/lib/services/contact-invitations-service";
import { isShareCancellationError } from "@/lib/share/share-link";

/** Session-owned UI state and handoffs survive temporary admission-gate remounts. */
export function useInvitationQueue(
  candidates: InviteCandidate[],
  share: InvitationShare | null,
  captureSession: () => () => boolean,
) {
  const [step, setStep] = useState<"select" | "review" | "queue">("select");
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [visible, setVisible] = useState(50);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, InviteDestination>>(
    {},
  );
  const [processed, setProcessed] = useState<Set<string>>(() => new Set());
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [outcome, setOutcome] = useState<InvitationOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const queue = candidates.filter((candidate) => selected[candidate.id]);
  const current = queue.find(
    (candidate) => !processed.has(candidate.id) && !skipped.has(candidate.id),
  );

  const reset = useCallback(() => {
    setStep("select");
    setQuery("");
    setPreviewId(null);
    setVisible(50);
    setChoices({});
    setSelected({});
    setProcessed(new Set());
    setSkipped(new Set());
    setOutcome(null);
    setError(null);
    busyRef.current = false;
    setBusy(false);
  }, []);

  const next = (skip: boolean) => {
    if (!current || busyRef.current) return;
    if (skip) setSkipped((previous) => new Set(previous).add(current.id));
    else setProcessed((previous) => new Set(previous).add(current.id));
    setOutcome(null);
    setError(null);
  };

  const act = async (kind: "compose" | "share" | "copy") => {
    if (!current || !share || busyRef.current) return;
    const isCurrentSession = captureSession();
    if (!isCurrentSession()) return;
    const recipient = current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const personal = personalizeInvitation(share, recipient.displayName);
      // Start directly on the tap, before any await, for browser activation.
      const result =
        kind === "compose"
          ? await ContactInvitationsService.compose(
              selected[recipient.id]!,
              personal,
            )
          : kind === "share"
            ? await ContactInvitationsService.share(personal)
            : await ContactInvitationsService.copy(personal);
      if (!isCurrentSession()) return;
      if (result === "copied") toast.success("Invitation copied");
      if (ContactInvitationsService.completesRecipient(result)) {
        setProcessed((previous) => new Set(previous).add(recipient.id));
      } else setOutcome(result);
    } catch (failure) {
      if (!isCurrentSession()) return;
      if (isShareCancellationError(failure)) setOutcome("cancelled");
      else
        setError(
          "Could not open or copy the invitation. Please try again, or select and copy the message above.",
        );
    } finally {
      if (isCurrentSession()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return {
    step,
    setStep,
    query,
    setQuery,
    previewId,
    setPreviewId,
    visible,
    setVisible,
    choices,
    setChoices,
    selected,
    setSelected,
    processed,
    skipped,
    outcome,
    error,
    busy,
    busyRef,
    queue,
    current,
    next,
    act,
    reset,
  };
}
