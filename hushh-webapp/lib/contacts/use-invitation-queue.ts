"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import {
  MAX_INVITATION_RECIPIENTS,
  isInvitePhone,
  normalizeInviteEmail,
  type InviteCandidate,
  type InviteDestination,
} from "./invitation-candidates";
import {
  ContactInvitationsService,
  type InvitationOutcome,
  type InvitationShare,
} from "@/lib/services/contact-invitations-service";
import { isShareCancellationError } from "@/lib/share/share-link";
import {
  oneLocationCountBucket,
  trackOneLocationJourneyAction,
} from "@/lib/observability/location-events";

/** Session-owned selection and one batch handoff survive admission-gate remounts. */
export function useInvitationQueue(
  sourceCandidates: InviteCandidate[],
  share: InvitationShare | null,
  captureSession: () => () => boolean,
) {
  const native = ContactInvitationsService.isNative();
  const candidates = useMemo(
    () =>
      sourceCandidates
        .flatMap((candidate) => {
          const destinations = candidate.destinations.flatMap((destination) => {
            if (native)
              return destination.kind === "phone" &&
                isInvitePhone(destination.value)
                ? [destination]
                : [];
            const email =
              destination.kind === "email"
                ? normalizeInviteEmail(destination.value)
                : null;
            return email ? [{ kind: "email" as const, value: email }] : [];
          });
          return destinations.length ? [{ ...candidate, destinations }] : [];
        })
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName, undefined, {
              sensitivity: "base",
              numeric: true,
            }) || left.id.localeCompare(right.id),
        ),
    [sourceCandidates, native],
  );
  const [step, setStep] = useState<"select" | "review" | "queue">("select");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(50);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [selected, updateSelected] = useState<
    Record<string, InviteDestination>
  >({});
  const [outcome, setOutcome] = useState<InvitationOutcome | null>(null);
  const [handoffOutcome, setHandoffOutcome] =
    useState<InvitationOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const queue = candidates.filter((candidate) => selected[candidate.id]);

  const setSelected = (
    action: SetStateAction<Record<string, InviteDestination>>,
  ) => {
    if (busyRef.current) return;
    updateSelected((previous) => {
      const next = typeof action === "function" ? action(previous) : action;
      const entries = Object.entries(next);
      if (entries.length > MAX_INVITATION_RECIPIENTS) return previous;
      const keys = new Set<string>();
      for (const [id, destination] of entries) {
        if (
          !candidates.some(
            (candidate) =>
              candidate.id === id &&
              candidate.destinations.some(
                (allowed) =>
                  allowed.kind === destination.kind &&
                  allowed.value === destination.value,
              ),
          )
        )
          return previous;
        const key = `${destination.kind}:${destination.value.toLowerCase()}`;
        if (keys.has(key)) return previous;
        keys.add(key);
      }
      return next;
    });
  };

  const reset = useCallback(() => {
    setStep("select");
    setQuery("");
    setVisible(50);
    setChoices({});
    updateSelected({});
    setOutcome(null);
    setHandoffOutcome(null);
    setError(null);
    busyRef.current = false;
    setBusy(false);
  }, []);

  const act = async (kind: "compose" | "share" | "copy") => {
    if ((kind === "compose" && !queue.length) || !share || busyRef.current)
      return;
    const isCurrentSession = captureSession();
    if (!isCurrentSession()) return;
    const message = { ...share };
    const recipients = queue.map((candidate) => ({
      ...selected[candidate.id]!,
    }));
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setOutcome(null);
    if (kind === "compose") {
      setHandoffOutcome(null);
      setStep("queue");
    }
    try {
      const result =
        kind === "compose"
          ? await ContactInvitationsService.composeBatch(
              recipients,
              message,
              isCurrentSession,
            )
          : kind === "share"
            ? await ContactInvitationsService.share(message, isCurrentSession)
            : await ContactInvitationsService.copy(message, isCurrentSession);
      if (!isCurrentSession()) return;
      trackOneLocationJourneyAction({
        action: "contact_invitation_handoff",
        result:
          result === "failed"
            ? "error"
            : result === "cancelled" || result === "unavailable"
              ? "expected_error"
              : "success",
        targetType: "contacts",
        countBucket: oneLocationCountBucket(recipients.length),
      });
      if (result === "copied") toast.success("Invitation copied");
      setOutcome(result);
      if (kind === "compose") setHandoffOutcome(result);
    } catch (failure) {
      if (!isCurrentSession()) return;
      trackOneLocationJourneyAction({
        action: "contact_invitation_handoff",
        result: isShareCancellationError(failure) ? "expected_error" : "error",
        targetType: "contacts",
        countBucket: oneLocationCountBucket(recipients.length),
      });
      if (isShareCancellationError(failure)) setOutcome("cancelled");
      else
        setError(
          "Could not open or copy the invitation. Try again, select fewer contacts, or copy the message below.",
        );
    } finally {
      if (isCurrentSession()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return {
    native,
    candidates,
    step,
    setStep,
    query,
    setQuery,
    visible,
    setVisible,
    choices,
    setChoices,
    selected,
    setSelected,
    outcome,
    handoffOutcome,
    error,
    busy,
    busyRef,
    queue,
    act,
    reset,
  };
}
