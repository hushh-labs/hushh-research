"use client";

import { useCallback, useEffect, useState } from "react";
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
  if (route.requestType === "calendar_meeting")
    return <CalendarMeetingReviewCard key={`${userId}:${requestId}:${route.revision}`} requestId={requestId} status={route}
      onChanged={() => { onChanged(); setRetry(value => value + 1); }} />;
  return <DocumentShareReview requestId={requestId} onChanged={onChanged} surface="sheet" counterpartLabel={counterpartLabel} />;
}

function CalendarMeetingReviewCard({ requestId, status, onChanged }: {
  requestId: string; status: SharingStatus; onChanged: () => void;
}) {
  const { userId } = useAuth();
  const { getVaultOwnerToken } = useVault();
  const [preview, setPreview] = useState<CalendarRequestPreview | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<CalendarSearch | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [occurrenceConfirmed, setOccurrenceConfirmed] = useState(false);
  const [review, setReview] = useState<SharingReview | null>(null);
  const [reviewFiles, setReviewFiles] = useState<string[]>([]);
  const [finalConfirmed, setFinalConfirmed] = useState(false);
  const [declineArmed, setDeclineArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    setBusy(true); setError("");
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
        if (!cancelled) setReview(ready);
      }
    })().catch(cause => { if (!cancelled && isVaultSessionEpochCurrent(epoch)) setError(errorText(cause)); })
      .finally(() => { if (!cancelled && isVaultSessionEpochCurrent(epoch)) setBusy(false); });
    return () => { cancelled = true; };
  }, [requestId, status.direction, status.revision, getVaultOwnerToken, guardFor]);

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

  const pending = status.status === "pending" || status.status === "preparing" || status.status === "review_ready";
  return <section className="space-y-4 rounded-xl border p-4">
    <h3 className="font-semibold">Meeting file request</h3>
    {busy && !preview ? <p role="status">Loading this meeting request…</p> : null}
    {preview ? <>
      <p><strong>{preview.meeting.title}</strong> · {preview.meeting.date}</p>
      <p>Requested: {preview.meeting.requested_types.join(" and ")}</p>
      <p>Recipient Google account: <strong>{preview.recipientEmail}</strong></p>
      <p className="text-sm text-muted-foreground">Choose only files for this meeting occurrence. Being the organizer does not by itself give you permission to share a file.</p>
      {!preview.ownerDriveReady && pending ? <p role="status">Connect the Google Drive account that can share these files. <ProfileConnectorsLink connectorId="google_drive" className="underline">Open Drive connection</ProfileConnectorsLink></p> : null}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {preview && pending && preview.ownerDriveReady && !review?.canApprove ? <div className="space-y-3">
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
        guard(); setNotice("Sharing was queued. The requester’s Calendar will show files after access is verified."); onChanged();
      })}>Share selected files</Button>
      <Button variant="ghost" disabled={busy} onClick={() => {
        setReview(null); setReviewFiles([]); setFinalConfirmed(false); setSearch(null);
      }}>Choose different files</Button>
    </div> : null}
    {preview && pending ? <div className="border-t pt-3"><Button variant="ghost" disabled={busy} onClick={() => {
      if (!declineArmed) { setDeclineArmed(true); return; }
      void run(async (token, guard) => {
        await DriveSharingService.decide(token, requestId, "decline", preview.revision, guard);
        guard(); setNotice("Request declined."); onChanged();
      });
    }}>{declineArmed ? "Confirm decline" : "Decline request"}</Button></div> : null}
    {!pending ? <p role="status">This request is {status.status.replaceAll("_", " ")}. Refresh to check the latest Drive outcome.</p> : null}
  </section>;
}
