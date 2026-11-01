"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarInsightsRequestError, CalendarInsightsService, type MeetingRequestOutcome, type VerifiedMeetingSelection } from "@/lib/services/calendar-insights-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { UNVERIFIED_ORGANIZER_RECOVERY, requestRecovery, type RequestRecovery } from "./calendar-insights-presentation";

export type RequestKind = "recording" | "notes";
/**
 * Where the requester stands before Send is offered. `checking`, `locked` and
 * `failed` are about the check itself and never claim the organizer is unconnected.
 */
export type Readiness =
  | { state: "checking" | "locked" | "failed" | "ready" | "pending" | "not_connected" }
  | { state: "refused"; recovery: RequestRecovery };

const CHECKING: Readiness = { state: "checking" };
type SentRequest = MeetingRequestOutcome["requests"][number];

function afterFailedCheck(failure: unknown): Readiness {
  const recovery = requestRecovery(failure instanceof CalendarInsightsRequestError
    ? { status: failure.status, code: failure.code, reason: failure.reason, message: failure.message }
    : { message: failure instanceof Error ? failure.message : undefined });
  if (recovery.connect) return { state: "not_connected" };
  return recovery.tone === "terminal" ? { state: "refused", recovery } : { state: "failed" };
}

/**
 * The meeting-file request journey for one selected meeting: ask the server
 * whether the organizer can receive a request, offer Send only when they can,
 * and keep the person's choices while that answer changes. The check is
 * advisory; creating the request checks the relationship again.
 *
 * `contextKey` identifies the meeting and account. Everything resets when it
 * changes, and a late answer for another meeting is dropped. `revision` moves
 * when the page refreshes (focus, Feed change), which re-checks anything that
 * is not yet ready, so an accepted connection is picked up without a reload.
 */
export function useMeetingRequest({ selection, contextKey, active, revision, getIdToken, getVaultOwnerToken, onSent }: {
  selection: VerifiedMeetingSelection | null; contextKey: string; active: boolean; revision: number;
  getIdToken: () => Promise<string>; getVaultOwnerToken: () => string | null;
  onSent: (occurrenceId: string, request: SentRequest) => void;
}) {
  const [choice, setChoice] = useState<RequestKind[]>([]);
  const [step, setStep] = useState<"closed" | "choose" | "confirm">("closed");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // Set only by a send that failed; a terminal one has no Send action left.
  const [failure, setFailure] = useState<RequestRecovery | null>(null);
  const [checked, setChecked] = useState<{ key: string; value: Readiness } | null>(null);
  const [tick, setTick] = useState(0);
  const readiness = checked?.key === contextKey ? checked.value : CHECKING;
  const epoch = snapshotVaultSessionEpoch();
  const latest = useRef({ selection, contextKey, readiness, getIdToken, getVaultOwnerToken, onSent, busy });
  latest.current = { selection, contextKey, readiness, getIdToken, getVaultOwnerToken, onSent, busy };
  const restoring = useRef<{ occurrenceId: string; types: RequestKind[] } | null>(null);

  useEffect(() => {
    const restored = restoring.current;
    restoring.current = null;
    const types = restored && restored.occurrenceId === latest.current.selection?.occurrence_id ? restored.types : [];
    setChoice(types); setStep(types.length ? "confirm" : "closed"); setNotice(""); setFailure(null); setBusy(false);
  }, [contextKey]);

  useEffect(() => {
    const target = latest.current.selection;
    if (!active || !target) return;
    const controller = new AbortController();
    const settle = (value: Readiness) => {
      if (controller.signal.aborted || !isVaultSessionEpochCurrent(epoch)) return;
      setChecked({ key: contextKey, value });
      if (value.state === "ready") setFailure(null);
    };
    const vaultToken = latest.current.getVaultOwnerToken();
    if (!vaultToken) { settle({ state: "locked" }); return () => controller.abort(); }
    void latest.current.getIdToken()
      .then(idToken => CalendarInsightsService.requestReadiness(target, idToken, vaultToken, controller.signal))
      .then(state => settle(state === "unavailable" ? { state: "refused", recovery: UNVERIFIED_ORGANIZER_RECOVERY } : { state }))
      .catch(error => settle(afterFailedCheck(error)));
    return () => controller.abort();
  }, [active, contextKey, tick, epoch]);

  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    if (latest.current.readiness.state !== "ready") setTick(value => value + 1);
  }, [revision]);

  const recheck = useCallback(() => {
    setChecked({ key: latest.current.contextKey, value: CHECKING });
    setTick(value => value + 1);
  }, []);

  /** Seed the next meeting selection, e.g. when returning from Connect or Google. */
  const restore = useCallback((occurrenceId: string, types: RequestKind[]) => {
    restoring.current = { occurrenceId, types };
  }, []);

  const send = useCallback(async () => {
    const { selection: target, contextKey: started, busy: sending } = latest.current;
    if (!target || sending || !choice.length) return;
    const vaultToken = latest.current.getVaultOwnerToken();
    if (!vaultToken) { setNotice("Unlock your vault to send this request."); return; }
    setBusy(true); setNotice(""); setFailure(null);
    try {
      const result = await CalendarInsightsService.requestFiles(target, choice, await latest.current.getIdToken(), vaultToken);
      if (latest.current.contextKey !== started || !isVaultSessionEpochCurrent(epoch)) return;
      setStep("closed");
      setNotice(`Request sent to the organizer. Files will be shared with ${result.recipientEmail} only after an exact-file approval and access check.`);
      latest.current.onSent(target.occurrence_id, { requestId: result.requestId, status: result.status, requestedTypes: choice });
    } catch (error) {
      if (latest.current.contextKey !== started) return;
      const recovery = requestRecovery(error instanceof CalendarInsightsRequestError
        ? { status: error.status, code: error.code, reason: error.reason, message: error.message }
        : { message: error instanceof Error ? error.message : undefined });
      // The server refused for the relationship: read where the requester stands now.
      if (recovery.connect) { recheck(); return; }
      setFailure(recovery);
      // A terminal refusal is explained by its own panel; a retryable one keeps the notice.
      setNotice(recovery.tone === "retry" ? recovery.message : "");
    } finally { if (latest.current.contextKey === started) setBusy(false); }
  }, [choice, epoch, recheck]);

  return {
    readiness, step, choice, busy, notice, failure, send, recheck,
    begin: () => { setChoice([]); setStep("choose"); setFailure(null); },
    review: () => setStep("confirm"),
    back: () => setStep("choose"),
    cancel: () => setStep("closed"),
    close: () => { setStep("closed"); setFailure(null); },
    toggle: (kind: RequestKind, on: boolean) => setChoice(previous => on ? [...previous, kind] : previous.filter(item => item !== kind)),
    restore,
  };
}
