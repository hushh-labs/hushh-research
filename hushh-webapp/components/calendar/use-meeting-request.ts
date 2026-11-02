"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarInsightsRequestError, CalendarInsightsService, type MeetingFileKind, type MeetingRequestState, type VerifiedMeetingSelection } from "@/lib/services/calendar-insights-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { UNVERIFIED_ORGANIZER_RECOVERY, isConnectionRefusal, requestRecovery, type RequestRecovery } from "./calendar-insights-presentation";

export type RequestKind = MeetingFileKind;
/** What the person picks: one file type, or both. */
export type RequestChoice = RequestKind | "both";
/**
 * Where the requester stands before an Ask is accepted. `checking`, `locked` and
 * `failed` are about the check itself and never claim the organizer is unconnected.
 * Only `not_connected` and `pending` keep Ask from sending.
 */
export type Readiness =
  | { state: "checking" | "locked" | "failed" | "ready" | "pending" | "not_connected" }
  | { state: "refused"; recovery: RequestRecovery };

const CHECKING: Readiness = { state: "checking" };
// A pending connection is rechecked on its own, for a bounded time, so an accepted
// connection is picked up without leaving the page or reloading it.
const PENDING_RECHECK_MS = 15_000;
const PENDING_RECHECK_LIMIT = 20;

export function choiceKinds(choice: RequestChoice | null): RequestKind[] {
  return choice === "both" ? ["recording", "notes"] : choice ? [choice] : [];
}

export function kindsChoice(kinds: readonly RequestKind[]): RequestChoice | null {
  const unique = Array.from(new Set(kinds));
  return unique.length === 2 ? "both" : unique[0] ?? null;
}

function failureOf(error: unknown) {
  return error instanceof CalendarInsightsRequestError
    ? { status: error.status, code: error.code, reason: error.reason, message: error.message }
    : { message: error instanceof Error ? error.message : undefined };
}

function afterFailedCheck(error: unknown): Readiness {
  const failure = failureOf(error);
  if (isConnectionRefusal(failure)) return { state: "not_connected" };
  const recovery = requestRecovery(failure);
  return recovery.tone === "terminal" ? { state: "refused", recovery } : { state: "failed" };
}

/**
 * The meeting-file request journey for one selected meeting: the person picks
 * Recording, Notes or Both and asks the organizer. The server checks the
 * relationship again when the request is created, so Ask never relies on this
 * advisory check alone; the check only keeps an unconnected requester from
 * sending, and decides whether to show the quiet connection hint.
 *
 * `contextKey` identifies the meeting and account. Everything resets when it
 * changes, and a late answer for another meeting is dropped. `revision` moves
 * when the page refreshes (focus, Feed change), which re-checks anything that
 * is not yet ready, so an accepted connection is picked up without a reload.
 */
export function useMeetingRequest({ selection, contextKey, active, revision, getIdToken, getVaultOwnerToken, onSent }: {
  selection: VerifiedMeetingSelection | null; contextKey: string; active: boolean; revision: number;
  getIdToken: () => Promise<string>; getVaultOwnerToken: () => string | null;
  onSent: (occurrenceId: string, request: MeetingRequestState) => void;
}) {
  const [choice, setChoice] = useState<RequestChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // Set only by a send that failed; a terminal one has no Ask action left.
  const [failure, setFailure] = useState<RequestRecovery | null>(null);
  const [checked, setChecked] = useState<{ key: string; value: Readiness } | null>(null);
  const [tick, setTick] = useState(0);
  const [pendingChecks, setPendingChecks] = useState({ key: "", count: 0 });
  const readiness = checked?.key === contextKey ? checked.value : CHECKING;
  const epoch = snapshotVaultSessionEpoch();
  const latest = useRef({ selection, contextKey, readiness, getIdToken, getVaultOwnerToken, onSent, busy, choice });
  latest.current = { selection, contextKey, readiness, getIdToken, getVaultOwnerToken, onSent, busy, choice };
  const restoring = useRef<{ occurrenceId: string; types: RequestKind[] } | null>(null);

  useEffect(() => {
    const restored = restoring.current;
    restoring.current = null;
    const types = restored && restored.occurrenceId === latest.current.selection?.occurrence_id ? restored.types : [];
    setChoice(kindsChoice(types)); setNotice(""); setFailure(null); setBusy(false);
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

  // A connection awaiting approval is checked again soon, a bounded number of times.
  const pendingCount = pendingChecks.key === contextKey ? pendingChecks.count : 0;
  useEffect(() => {
    if (!active || readiness.state !== "pending" || pendingCount >= PENDING_RECHECK_LIMIT) return;
    const timer = window.setTimeout(() => {
      setPendingChecks({ key: contextKey, count: pendingCount + 1 });
      setTick(value => value + 1);
    }, PENDING_RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [active, readiness.state, checked, pendingCount, contextKey]);

  const recheck = useCallback(() => {
    setChecked({ key: latest.current.contextKey, value: CHECKING });
    setTick(value => value + 1);
  }, []);

  /** Seed the next meeting selection, e.g. when returning from Google. */
  const restore = useCallback((occurrenceId: string, types: RequestKind[]) => {
    restoring.current = { occurrenceId, types };
  }, []);

  /**
   * Ask the organizer for the chosen files that are still outstanding. Nothing is
   * sent while the connection is known not to be ready; the server decides again
   * and a refusal for the relationship only brings the quiet hint back.
   */
  const ask = useCallback(async (offered: readonly RequestKind[]) => {
    const { selection: target, contextKey: started, busy: sending, readiness: current } = latest.current;
    // With one type left to ask for there is nothing to pick; the section shows it as chosen.
    const kinds = (offered.length === 1 ? [...offered] : choiceKinds(latest.current.choice)).filter(kind => offered.includes(kind));
    if (!target || sending || !kinds.length) return;
    if (current.state === "not_connected" || current.state === "pending" || current.state === "refused") return;
    const vaultToken = latest.current.getVaultOwnerToken();
    if (!vaultToken) { setNotice("Unlock your vault to ask the organizer."); return; }
    setBusy(true); setNotice(""); setFailure(null);
    try {
      const result = await CalendarInsightsService.requestFiles(target, kinds, await latest.current.getIdToken(), vaultToken);
      if (latest.current.contextKey !== started || !isVaultSessionEpochCurrent(epoch)) return;
      setChoice(null);
      latest.current.onSent(target.occurrence_id, {
        requestId: result.requestId, status: result.status,
        requestedTypes: result.requestedTypes.length ? result.requestedTypes : kinds,
        notAvailableTypes: result.notAvailableTypes,
      });
    } catch (error) {
      if (latest.current.contextKey !== started) return;
      const reason = failureOf(error);
      // The server refused for the relationship: read where the requester stands now, quietly.
      if (isConnectionRefusal(reason)) { recheck(); return; }
      const recovery = requestRecovery(reason);
      setFailure(recovery);
      // A terminal refusal is explained by its own panel; a retryable one keeps the notice.
      setNotice(recovery.tone === "retry" ? recovery.message : "");
    } finally { if (latest.current.contextKey === started) setBusy(false); }
  }, [epoch, recheck]);

  return {
    readiness, choice, busy, notice, failure, ask, recheck, restore,
    choose: (next: RequestChoice) => { setChoice(next); setFailure(null); setNotice(""); },
    close: () => setFailure(null),
  };
}
