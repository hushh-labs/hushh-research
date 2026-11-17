"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProfileConnectorsLink } from "@/components/profile/profile-connectors-link";
import { CalendarMeetingReviewService, type CalendarRequestPreview, type CalendarSearch } from "@/lib/services/calendar-meeting-review-service";
import { DriveSharingService, type SharingReview, type SharingSessionGuard, type SharingStatus } from "@/lib/services/drive-sharing-service";
import { DriveSharingError } from "@/lib/services/drive-sharing-wire";
import { DocumentShareReview } from "@/components/consent/document-share-review";
import { ROUTES } from "@/lib/navigation/routes";
import { isMeetingReviewing, meetingOutcome } from "@/lib/consent/calendar-meeting-outcome";
import { consumeMeetingReviewGiveIntent, markMeetingReviewGiveIntent, markMeetingReviewOAuthReturn } from "@/lib/consent/meeting-review-return";
import { meetingFilesPhrase, notAvailableMessage } from "@/lib/calendar/meeting-file-copy";
import type { MeetingFileKind } from "@/lib/services/calendar-insights-service";

// Sharing is quick when it works; poll quietly for a bounded time, then stop and
// offer a manual check rather than polling a stuck job forever.
const SHARING_POLL_MS = 2_500;
const SHARING_POLL_LIMIT = 40;

function errorText(error: unknown): string {
  if (!(error instanceof DriveSharingError)) return "This meeting request could not be checked. Try again.";
  switch (error.code) {
    case "source_changed": return "A selected file changed or cannot be shared. Search again and select the exact files.";
    case "connection_changed": case "reconnect_required": return "The Drive account changed. Reconnect it and search again.";
    case "recipient_changed": return "The recipient's selected Google account changed. Ask them to request again.";
    case "review_changed": return "This review changed. Refresh it before sharing.";
    case "source_not_shareable": return "Google Drive does not allow sharing one of those files.";
    case "request_unavailable": return "This meeting request is no longer available.";
    default: return "This meeting request could not be completed. Refresh and try again.";
  }
}

export function DocumentRequestReviewRouter({ requestId, onChanged, counterpartLabel }: {
  requestId: string; onChanged: () => void; counterpartLabel?: string | null;
}) {
  const { userId } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  const [route, setRoute] = useState<SharingStatus | "loading" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const token = getVaultOwnerToken();
    if (!userId || !isVaultUnlocked || !token) { setRoute("loading"); return; }
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    const guard: SharingSessionGuard = () => {
      if (cancelled || !isVaultSessionEpochCurrent(epoch) || getVaultOwnerToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    setRoute("loading");
    void DriveSharingService.status(token, requestId, guard)
      .then(value => { guard(); setRoute(value); })
      .catch(() => { if (!cancelled && isVaultSessionEpochCurrent(epoch)) setRoute("error"); });
    return () => { cancelled = true; };
  }, [requestId, userId, isVaultUnlocked, getVaultOwnerToken, retry]);
  if (!userId || !isVaultUnlocked) return <p role="status">Unlock your vault to review this request.</p>;
  if (route === "loading") return <p role="status">Checking request type…</p>;
  if (route === "error") return <div><p role="alert">This request could not be checked securely.</p><Button onClick={() => setRetry(value => value + 1)}>Try again</Button></div>;
  // The card tracks its own status after an action, so it must not be remounted
  // (and its Sharing/outcome panel reset) by a re-fetch here.
  if (route.requestType === "calendar_meeting")
    return <CalendarMeetingReviewCard key={`${userId}:${requestId}`} requestId={requestId} status={route}
      onChanged={onChanged} />;
  return <DocumentShareReview requestId={requestId} onChanged={onChanged} surface="sheet" counterpartLabel={counterpartLabel} />;
}

function CalendarMeetingReviewCard({ requestId, status: initialStatus, onChanged }: {
  requestId: string; status: SharingStatus; onChanged: () => void;
}) {
  const { userId } = useAuth();
  const { getVaultOwnerToken } = useVault();
  // Server truth for this request, refreshed in place so the page never remounts.
  const [status, setStatus] = useState<SharingStatus>(initialStatus);
  const [pollStopped, setPollStopped] = useState(false);
  const [pollRun, setPollRun] = useState(0);
  // A parent may pass an unstable callback; the poll must not restart for it.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(() => { setStatus(current => current.revision === initialStatus.revision ? current : initialStatus); }, [initialStatus]);
  const [preview, setPreview] = useState<CalendarRequestPreview | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<CalendarSearch | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [occurrenceConfirmed, setOccurrenceConfirmed] = useState(false);
  const [review, setReview] = useState<SharingReview | null>(null);
  const [reviewFiles, setReviewFiles] = useState<string[]>([]);
  const [finalConfirmed, setFinalConfirmed] = useState(false);
  const [declineArmed, setDeclineArmed] = useState(false);
  // The organizer first chooses how to answer: Give access, or Don't have.
  // A return from Drive authorization reopens the Give access step.
  const [mode, setMode] = useState<"choose" | "give" | "dont">(() => consumeMeetingReviewGiveIntent(userId, requestId) ? "give" : "choose");
  const [lacking, setLacking] = useState<MeetingFileKind[]>([]);
  const [saved, setSaved] = useState<MeetingFileKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Bumped when the organizer comes back from authorizing Drive, so this same
  // review re-checks readiness in place instead of needing a reload.
  const [previewRun, setPreviewRun] = useState(0);
  const quietRecheck = useRef(false);
  const guardFor = useCallback((token: string, epoch: number): SharingSessionGuard => () => {
    if (!userId || !isVaultSessionEpochCurrent(epoch) || getVaultOwnerToken() !== token)
      throw new DriveSharingError("session_changed");
  }, [getVaultOwnerToken, userId]);

  useEffect(() => {
    if (status.direction !== "incoming") return;
    const token = getVaultOwnerToken();
    if (!token) return;
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    const guard = guardFor(token, epoch);
    // A return from Drive authorization refreshes quietly: no spinner, no
    // cleared error, no layout shift on a page the organizer is already using.
    const quiet = quietRecheck.current;
    quietRecheck.current = false;
    if (!quiet) { setBusy(true); setError(""); }
    void (async () => {
      const next = await CalendarMeetingReviewService.preview(requestId, token);
      guard();
      if (cancelled) return;
      setPreview(next);
      if (next.status === "review_ready") {
        const ready = await DriveSharingService.review(token, requestId, guard);
        guard();
        if (ready.requestType !== "calendar_meeting" || ready.recipientEmail !== next.recipientEmail)
          throw new DriveSharingError("review_changed");
        if (!cancelled) { setReview(ready); setMode("give"); }
      }
    })().catch(cause => { if (!quiet && !cancelled && isVaultSessionEpochCurrent(epoch)) setError(errorText(cause)); })
      .finally(() => { if (!quiet && !cancelled && isVaultSessionEpochCurrent(epoch)) setBusy(false); });
    return () => { cancelled = true; };
  }, [requestId, status.direction, status.revision, previewRun, getVaultOwnerToken, guardFor]);

  const driveBlocked = status.direction === "incoming" && isMeetingReviewing(status.status) && preview !== null && !preview.ownerDriveReady;
  const recheckDrive = useCallback(() => { quietRecheck.current = true; setPreviewRun(value => value + 1); }, []);
  useEffect(() => {
    if (!driveBlocked) return;
    let last = 0;
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < 1_500) return;
      last = now;
      recheckDrive();
    };
    // Authorization happens in a popup, tab or pane over this page; any of them
    // ending brings the organizer back here.
    window.addEventListener("focus", onReturn);
    window.addEventListener("popstate", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("popstate", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [driveBlocked, recheckDrive]);

  const outcome = status.direction === "incoming" ? meetingOutcome(status.status) : null;
  const sharing = outcome?.inProgress === true;
  useEffect(() => {
    if (!sharing) return;
    const token = getVaultOwnerToken();
    if (!token) return;
    const epoch = snapshotVaultSessionEpoch();
    const guard = guardFor(token, epoch);
    let cancelled = false;
    let timer: number | undefined;
    let polls = 0;
    setPollStopped(false);
    const tick = async () => {
      try {
        const next = await DriveSharingService.status(token, requestId, guard);
        guard();
        if (cancelled) return;
        if (next.requestType === "calendar_meeting" && next.direction === "incoming") setStatus(next);
        if (!meetingOutcome(next.status)?.inProgress) { onChangedRef.current(); return; }
      } catch {
        // A transient read must not end the poll; the limit below does.
      }
      polls += 1;
      if (cancelled) return;
      if (polls >= SHARING_POLL_LIMIT) { setPollStopped(true); return; }
      timer = window.setTimeout(() => void tick(), SHARING_POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), SHARING_POLL_MS);
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [sharing, pollRun, requestId, getVaultOwnerToken, guardFor]);

  const run = async (action: (token: string, guard: SharingSessionGuard) => Promise<void>) => {
    const token = getVaultOwnerToken();
    if (!token || busy) { setError("Unlock your vault to continue."); return; }
    const epoch = snapshotVaultSessionEpoch();
    const guard = guardFor(token, epoch);
    setBusy(true); setError(""); setNotice("");
    try { await action(token, guard); guard(); }
    catch (cause) { if (isVaultSessionEpochCurrent(epoch)) setError(errorText(cause)); }
    finally { if (isVaultSessionEpochCurrent(epoch)) setBusy(false); }
  };

  if (status.direction === "outgoing") return <section className="space-y-3 rounded-xl border p-4">
    <h3 className="font-semibold">Meeting recording and notes request</h3>
    <p role="status">{status.status === "approved" ? "Organizer approved. Open Calendar to verify file access with your selected account." :
      status.status === "declined" ? "The organizer declined this request." :
      status.status === "failed" ? "Drive sharing did not complete." : "Waiting for the organizer to review this meeting's files."}</p>
    <Link href="/one/calendar" className="underline">Open Calendar</Link>
  </section>;

  const pending = isMeetingReviewing(status.status);
  // What the organizer has already said they don't have, and what is still open to answer.
  const said = Array.from(new Set([...(preview?.notAvailableTypes ?? []), ...saved]));
  const openTypes = (preview?.meeting.requested_types ?? []).filter(kind => !said.includes(kind));
  // The two answers are offered until the exact-file confirmation takes over.
  const choosing = pending && !review?.canApprove;
  const shownOutcome = outcome && status.status === "declined" && said.length
    ? { ...outcome, title: "Saved", detail: `The requester sees that you don't have the ${meetingFilesPhrase(said, "or")}. Nothing was shared.` }
    : outcome;
  const startGive = () => {
    setMode("give"); setNotice(""); setError(""); setDeclineArmed(false);
    // Files Google links to this exact meeting are checked for you; you still choose and confirm them.
    if (preview?.ownerDriveReady && preview.meeting.exact_refs?.length && !search)
      void run(async token => {
        const result = await CalendarMeetingReviewService.linkedFiles(requestId, token);
        setSearch(result); setSelectedFiles([]); setOccurrenceConfirmed(false);
      });
  };
  const startDont = () => {
    setMode("dont"); setNotice(""); setError(""); setDeclineArmed(false);
    setLacking(openTypes.length === 1 ? openTypes : []);
  };
  const saveDont = () => void run(async (token, guard) => {
    if (!preview || !lacking.length) return;
    const told = lacking;
    const result = await CalendarMeetingReviewService.markUnavailable(requestId, token, preview.revision, told);
    guard();
    quietRecheck.current = true;
    setSaved(result.notAvailableTypes); setLacking([]); setMode("choose");
    setSearch(null); setSelectedFiles([]); setOccurrenceConfirmed(false);
    setStatus(current => ({ ...current, status: result.status, revision: result.revision }));
    setNotice(`Saved. They'll see: "${notAvailableMessage(told)}"`);
    onChanged();
  });
  return <section className="space-y-4 rounded-xl border p-4">
    <h3 className="font-semibold">Meeting file request</h3>
    {busy && !preview ? <p role="status">Loading this meeting request…</p> : null}
    {preview ? <>
      <p><strong>{preview.meeting.title}</strong> · {preview.meeting.date}</p>
      <p>Requested: {meetingFilesPhrase(preview.meeting.requested_types)}</p>
      {said.length ? <p role="status">You said you don't have the {meetingFilesPhrase(said, "or")}.</p> : null}
      <p>Recipient Google account: <strong>{preview.recipientEmail}</strong></p>
      <p className="text-sm text-muted-foreground">Choose only files for this meeting occurrence. Being the organizer does not by itself give you permission to share a file.</p>
      {!preview.ownerDriveReady && choosing && mode === "give" ? <div role="status" className="space-y-2">
        <p>Connect the Google Drive account that can share these files. You will come back to this request.</p>
        <p className="flex flex-wrap items-center gap-3">
          <ProfileConnectorsLink connectorId="google_drive" className="underline"
            onClick={() => { if (userId) { markMeetingReviewOAuthReturn(userId, requestId); markMeetingReviewGiveIntent(userId, requestId); } }}>Open Drive connection</ProfileConnectorsLink>
          <Button variant="outline" size="sm" onClick={recheckDrive}>Check Drive connection</Button>
        </p>
      </div> : null}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {preview && choosing && openTypes.length ? <div role="group" aria-label="Answer this request" className="grid grid-cols-2 gap-2">
      <Button aria-pressed={mode === "give"} variant={mode === "give" ? "default" : "outline"} disabled={busy} onClick={startGive}>Give access</Button>
      <Button aria-pressed={mode === "dont"} variant={mode === "dont" ? "default" : "outline"} disabled={busy} onClick={startDont}>Don't have</Button>
    </div> : null}
    {preview && choosing && mode === "dont" && openTypes.length ? <div className="space-y-3" role="group" aria-label="Which do you not have?">
      <p>Which of these don't you have?</p>
      {openTypes.map(kind => <label key={kind} className="flex items-start gap-2"><input type="checkbox" checked={lacking.includes(kind)}
        onChange={event => setLacking(previous => event.target.checked ? [...previous, kind] : previous.filter(item => item !== kind))} />
        <span>The {kind}</span></label>)}
      <p className="text-sm text-muted-foreground">Nothing in your Drive is opened. {lacking.length ? `They'll see: "${notAvailableMessage(lacking)}"` : "They are told which one you don't have."}</p>
      <Button disabled={busy || !lacking.length} onClick={saveDont}>Confirm</Button>
    </div> : null}
    {preview && choosing && mode === "give" && preview.ownerDriveReady ? <div className="space-y-3">
      {preview.meeting.exact_refs?.length ? <Button variant="outline" disabled={busy} onClick={() => void run(async token => {
        const result = await CalendarMeetingReviewService.linkedFiles(requestId, token);
        setSearch(result); setSelectedFiles([]); setOccurrenceConfirmed(false);
      })}>Check files linked to this meeting</Button> : null}
      <label className="block">Search your Drive for the exact meeting files
        <Input value={query} maxLength={80} onChange={event => { setQuery(event.target.value); setSearch(null); setSelectedFiles([]); setOccurrenceConfirmed(false); }} placeholder="Enter a file name" />
      </label>
      <Button disabled={busy || query.trim().length < 3} onClick={() => void run(async token => {
        const result = await CalendarMeetingReviewService.search(requestId, token, query.trim());
        setSearch(result); setSelectedFiles([]); setOccurrenceConfirmed(false);
      })}>Search files</Button>
      {search ? <div className="space-y-2">
        <p>Drive account: <strong>{search.accountLabel || "Connected Drive account"}</strong></p>
        {search.hasMore ? <p role="status">More results exist. Narrow the search before selecting files.</p> : null}
        {!search.files.length ? <p>No shareable recording or notes matched. Try a more specific file name or check sharing in Drive.</p> : null}
        {search.files.map(file => <label key={file.file_id} className="flex items-start gap-2"><input type="checkbox"
          checked={selectedFiles.includes(file.file_id)} disabled={!selectedFiles.includes(file.file_id) && selectedFiles.length >= 8}
          onChange={event => setSelectedFiles(previous => event.target.checked ? [...previous, file.file_id] : previous.filter(id => id !== file.file_id))} />
          <span>{file.name} <small>({file.artifact_kind})</small></span></label>)}
        <label className="flex items-start gap-2"><input type="checkbox" checked={occurrenceConfirmed} onChange={event => setOccurrenceConfirmed(event.target.checked)} />
          <span>I confirm these exact files belong to this meeting occurrence and should be reviewed for sharing with {preview.recipientEmail}.</span></label>
        <Button disabled={busy || !selectedFiles.length || !occurrenceConfirmed} onClick={() => void run(async (token, guard) => {
          await CalendarMeetingReviewService.prepare(requestId, token, search, selectedFiles);
          guard();
          const current = await CalendarMeetingReviewService.preview(requestId, token);
          guard();
          if (current.recipientEmail !== preview.recipientEmail) throw new DriveSharingError("review_changed");
          setPreview(current);
          const ready = await DriveSharingService.review(token, requestId, guard);
          if (ready.requestType !== "calendar_meeting" || ready.recipientEmail !== preview.recipientEmail || !ready.canApprove)
            throw new DriveSharingError("review_changed");
          setReview(ready); setReviewFiles([]); setFinalConfirmed(false); setSearch(null);
        })}>Prepare exact-file review</Button>
      </div> : null}
    </div> : null}
    {preview && review?.canApprove && pending ? <div className="space-y-3">
      <h4 className="font-medium">Final file and recipient review</h4>
      <p>Share only the checked files with <strong>{review.recipientEmail}</strong>. Google Drive will still check actual sharing permission.</p>
      {review.files.map(file => <label key={file.documentId} className="flex items-start gap-2"><input type="checkbox" checked={reviewFiles.includes(file.documentId)} onChange={event => setReviewFiles(previous => event.target.checked ? [...previous, file.documentId] : previous.filter(id => id !== file.documentId))} />{file.name}</label>)}
      <label className="flex items-start gap-2"><input type="checkbox" checked={finalConfirmed} onChange={event => setFinalConfirmed(event.target.checked)} />I confirm these selected files are for {preview.meeting.title} and the recipient is {review.recipientEmail}.</label>
      <Button disabled={busy || !reviewFiles.length || !finalConfirmed} onClick={() => void run(async (token, guard) => {
        await DriveSharingService.approve(token, requestId, review, guard, reviewFiles, false, undefined, true);
        guard();
        // Approval is durable; Drive sharing now runs. Show Sharing until the server settles.
        setReview(null); setReviewFiles([]); setFinalConfirmed(false);
        setStatus(current => ({ ...current, status: "approved" }));
        onChanged();
      })}>Give access</Button>
      <Button variant="ghost" disabled={busy} onClick={() => {
        setReview(null); setReviewFiles([]); setFinalConfirmed(false); setSearch(null); setMode("give");
      }}>Choose different files</Button>
    </div> : null}
    {preview && pending ? <div className="border-t pt-3"><Button variant="ghost" disabled={busy} onClick={() => {
      if (!declineArmed) { setDeclineArmed(true); return; }
      void run(async (token, guard) => {
        await DriveSharingService.decide(token, requestId, "decline", preview.revision, guard);
        guard(); setStatus(current => ({ ...current, status: "declined" })); onChanged();
      });
    }}>{declineArmed ? "Confirm decline" : "Decline request"}</Button></div> : null}
    {shownOutcome ? <div className="space-y-2 border-t pt-3" data-testid="calendar-review-outcome" data-outcome={status.status}>
      <h4 className="font-medium">{shownOutcome.title}</h4>
      <p role={shownOutcome.tone === "error" ? "alert" : "status"}>{shownOutcome.detail}</p>
      {sharing && pollStopped ? <div className="space-y-2">
        <p role="status">This is taking longer than usual. Sharing continues in the background.</p>
        <Button variant="outline" onClick={() => setPollRun(value => value + 1)}>Check again</Button>
      </div> : null}
    </div> : null}
    {!pending || saved.length ? <Button asChild variant="outline"><Link href={ROUTES.ONE_FEED}>Back to Feed</Link></Button> : null}
  </section>;
}
