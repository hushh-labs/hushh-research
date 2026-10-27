"use client";
import { useEffect, useRef, useState } from "react";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { requireDocumentSession, type DocumentSession } from "@/lib/services/document-hosting-service";
import { type OneCopyActivity, type OneCopyActivityPage } from "@/lib/services/one-copy-service";
import { OneCopyPresentationService } from "@/lib/services/one-copy-presentation-service";

const labels: Record<OneCopyActivity["kind"], string> = {
  preview_requested: "Preview requested", download_requested: "Download requested",
  stream_completed: "Transfer completed", copy_ready: "Copy ready", revoked: "Access stopped",
};
/** Owner-only server evidence; a transfer never establishes display or durable saving. */
export function BackgroundDocumentActivity({ session, requestId }: { session: DocumentSession; requestId: string }) {
  const [open, setOpen] = useState(false); const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<OneCopyActivityPage | null>(() => OneCopyPresentationService.peekActivity(session, requestId));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const scope = useRef({ session, requestId });
  const active = useRef<AbortController | null>(null); const loading = useRef(false);
  const read = async (controller: AbortController, cursor?: string) => {
    if (loading.current) return;
    loading.current = true; setBusy(true); setError(false);
    try {
      const next = await OneCopyPresentationService.activity(session, requestId, controller.signal, cursor, revision > 0);
      requireDocumentSession(session, controller.signal);
      if (active.current !== controller) return;
      setPage(previous => ({ items: cursor ? Array.from(new Map([...(previous?.items ?? []), ...next.items].map(event => [event.eventId, event])).values()) : next.items, nextCursor: next.nextCursor }));
    } catch { if (!controller.signal.aborted && session.isCurrent()) setError(true); }
    finally { if (active.current === controller) { loading.current = false; setBusy(false); } }
  };
  useEffect(() => {
    scope.current = { session, requestId };
    setError(false); setBusy(false); loading.current = false;
    if (!open) return;
    setPage(OneCopyPresentationService.peekActivity(session, requestId));
    const controller = new AbortController(); active.current = controller; void read(controller);
    const timer = setInterval(() => {
      if (!session.isCurrent()) { controller.abort(); setPage(null); setOpen(false); }
    }, 1000);
    return () => { clearInterval(timer); controller.abort(); if (active.current === controller) active.current = null; };
    // Opening or refreshing creates a new session-bound page sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, requestId, open, revision]);
  const shown = scope.current.session === session && scope.current.requestId === requestId && session.isCurrent() ? page : null;
  return <div className="space-y-2">
    <Button data-voice-control-id="document-copy-activity" size="compact" variant="none" aria-expanded={open} onClick={() => setOpen(value => !value)}>Activity</Button>
    {open ? <div role="region" aria-label="One copy activity" className="space-y-3">
      {shown?.items.map(event => <div key={event.eventId}>
        <BodyText>{event.actorRole ? `${event.actorRole === "recipient" ? "Recipient" : event.actorRole === "owner" ? "Owner" : "System"} · ` : ""}{labels[event.kind]}</BodyText>
        <HelperText>{new Date(event.createdAt).toLocaleString()}{event.country ? ` · Approximate country: ${event.country}` : ""}</HelperText>
      </div>)}
      {shown?.items.length === 0 ? <HelperText>No activity yet.</HelperText> : null}
      <HelperText role={error ? "alert" : busy ? "status" : undefined} aria-hidden={!busy && !error}>{error ? "Activity unavailable. Try again." : busy ? "Loading activity…" : " "}</HelperText>
      <Button data-voice-control-id="document-copy-refresh-activity" size="compact" variant="none" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh activity</Button>
      {shown?.nextCursor ? <Button data-voice-control-id="document-copy-more-activity" size="compact" variant="none" disabled={busy} onClick={() => { if (active.current) void read(active.current, shown.nextCursor!); }}>More activity</Button> : null}
    </div> : null}
  </div>;
}
