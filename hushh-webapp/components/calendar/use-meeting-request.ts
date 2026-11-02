"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarInsightsRequestError, CalendarInsightsService, type MeetingFileKind, type MeetingRequestState, type VerifiedMeetingSelection } from "@/lib/services/calendar-insights-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { isConnectionRefusal, requestRecovery, type RequestRecovery } from "./calendar-insights-presentation";

export type RequestKind = MeetingFileKind;
/** What the person picks: one file type, or both. */
export type RequestChoice = RequestKind | "both";

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

/**
 * The meeting-file request journey for one selected meeting: the person picks
 * Recording, Notes or Both and asks the organizer. There is no pre-check: Ask is
 * always available once a type is chosen, and the server decides when the
 * request is created. A connected requester's request goes to the organizer's
 * One Feed; for anyone else nothing is sent and the quiet Connect hint appears.
 *
 * `contextKey` identifies the meeting and account. Everything resets when it
 * changes, and a late answer for another meeting is dropped.
 */
export function useMeetingRequest({ selection, contextKey, getIdToken, getVaultOwnerToken, onSent }: {
  selection: VerifiedMeetingSelection | null; contextKey: string;
  getIdToken: () => Promise<string>; getVaultOwnerToken: () => string | null;
  onSent: (occurrenceId: string, request: MeetingRequestState) => void;
}) {
  const [choice, setChoice] = useState<RequestChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // Set only when the server found no connection to the organizer; nothing was sent.
  const [notConnected, setNotConnected] = useState(false);
  // Set only by a send that failed; a terminal one has no Ask action left.
  const [failure, setFailure] = useState<RequestRecovery | null>(null);
  const epoch = snapshotVaultSessionEpoch();
  const latest = useRef({ selection, contextKey, getIdToken, getVaultOwnerToken, onSent, busy, choice });
  latest.current = { selection, contextKey, getIdToken, getVaultOwnerToken, onSent, busy, choice };
  const restoring = useRef<{ occurrenceId: string; types: RequestKind[] } | null>(null);

  useEffect(() => {
    const restored = restoring.current;
    restoring.current = null;
    const types = restored && restored.occurrenceId === latest.current.selection?.occurrence_id ? restored.types : [];
    setChoice(kindsChoice(types)); setNotice(""); setNotConnected(false); setFailure(null); setBusy(false);
  }, [contextKey]);

  /** Seed the next meeting selection, e.g. when returning from Google. */
  const restore = useCallback((occurrenceId: string, types: RequestKind[]) => {
    restoring.current = { occurrenceId, types };
  }, []);

  /**
   * Ask the organizer for the chosen files that are still outstanding. The server
   * resolves the organizer among the requester's own connections: a connected
   * organizer receives the request in their One Feed; otherwise nothing is sent.
   */
  const ask = useCallback(async (offered: readonly RequestKind[]) => {
    const { selection: target, contextKey: started, busy: sending } = latest.current;
    // With one type left to ask for there is nothing to pick; the section shows it as chosen.
    const kinds = (offered.length === 1 ? [...offered] : choiceKinds(latest.current.choice)).filter(kind => offered.includes(kind));
    if (!target || sending || !kinds.length) return;
    const vaultToken = latest.current.getVaultOwnerToken();
    if (!vaultToken) { setNotice("Unlock your vault to ask the organizer."); return; }
    setBusy(true); setNotice(""); setNotConnected(false); setFailure(null);
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
      // The server could not find the organizer among the requester's connections: nothing was sent.
      if (isConnectionRefusal(reason)) { setNotConnected(true); return; }
      const recovery = requestRecovery(reason);
      setFailure(recovery);
      // A terminal refusal is explained by its own panel; a retryable one keeps the notice.
      setNotice(recovery.tone === "retry" ? recovery.message : "");
    } finally { if (latest.current.contextKey === started) setBusy(false); }
  }, [epoch]);

  return {
    choice, busy, notice, notConnected, failure, ask, restore,
    choose: (next: RequestChoice) => { setChoice(next); setFailure(null); setNotice(""); setNotConnected(false); },
    close: () => setFailure(null),
  };
}
