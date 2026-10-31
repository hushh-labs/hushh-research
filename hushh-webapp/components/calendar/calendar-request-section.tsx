"use client";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import type { Meeting } from "@/lib/services/calendar-insights-service";
import { NOT_CONNECTED_RECOVERY, PENDING_CONNECTION_TEXT } from "./calendar-insights-presentation";
import { RequestRecoveryPanel } from "./calendar-request-recovery";
import type { RequestKind, useMeetingRequest } from "./use-meeting-request";
import styles from "./calendar-insights.module.css";

/**
 * Request missing recording or notes from the organizer. Choosing files and Send
 * appear only after the server confirms a connection to the organizer; until
 * then the person sees the connection state and, when it helps, Connect.
 */
export function CalendarRequestSection({ request, meeting, day, accountEmail, missingKinds, copyText, contextGuard, onConnect }: {
  request: ReturnType<typeof useMeetingRequest>; meeting: Meeting; day: string; accountEmail: string;
  missingKinds: readonly RequestKind[]; copyText: string; contextGuard: () => () => boolean; onConnect: () => void;
}) {
  const { readiness, step, choice, busy, notice, failure } = request;
  const label = (kind: RequestKind) => kind === "recording" ? "Recording" : "Notes";
  const organizer = meeting.organizer?.displayName || meeting.organizer?.email || "Unavailable";
  let body;
  if (readiness.state === "checking") body = <p role="status" className={styles.muted}>Checking your connection to the organizer…</p>;
  else if (readiness.state === "locked") body = <p role="status" className={styles.muted}>Unlock your vault to request files.</p>;
  else if (readiness.state === "failed") body = <div className="space-y-2">
    <p role="status" className={styles.muted}>Couldn&apos;t check your connection to the organizer.</p>
    <Button variant="outline" onClick={request.recheck}>Try again</Button>
  </div>;
  else if (readiness.state === "pending") body = <p role="status" className={styles.muted}>{PENDING_CONNECTION_TEXT}</p>;
  else if (readiness.state === "not_connected") body = <RequestRecoveryPanel recovery={NOT_CONNECTED_RECOVERY} copyText={copyText} contextGuard={contextGuard} onConnect={onConnect} />;
  else if (readiness.state === "refused") body = <RequestRecoveryPanel recovery={readiness.recovery} copyText={copyText} contextGuard={contextGuard} />;
  else body = <>
    {step === "closed" ? <Button variant="outline" onClick={request.begin}>Request recording or notes</Button> : null}
    {step === "choose" ? <div className="space-y-3"><p>Choose the files to ask the organizer for. A request does not grant access.</p>
      {missingKinds.map(kind => <label key={kind} className="flex items-center gap-2"><input type="checkbox" checked={choice.includes(kind)} onChange={event => request.toggle(kind, event.target.checked)} />{label(kind)}</label>)}
      <Button disabled={!choice.length} onClick={request.review}>Review request</Button>
      <Button variant="ghost" onClick={request.cancel}>Cancel</Button>
    </div> : null}
    {step === "confirm" && failure?.tone !== "terminal" ? <div className="space-y-3"><p><strong>{meeting.title}</strong> · {day}</p><p>Organizer: {organizer}</p><p>Requested: {choice.join(" and ")}</p><p>Recipient Google account: <strong>{accountEmail}</strong></p>
      <p>The organizer must confirm the exact files and recipient before Drive sharing. Access appears here only after your selected account can open a file.</p>
      <Button disabled={busy} onClick={() => void request.send()}>{busy ? "Sending…" : failure ? "Try again" : "Send request"}</Button>
      <Button variant="ghost" disabled={busy} onClick={request.back}>Back</Button>
    </div> : null}
    {failure ? <RequestRecoveryPanel recovery={failure} copyText={copyText} contextGuard={contextGuard} onClose={request.close} /> : null}
  </>;
  return <SectionCard title="Request missing files">
    {notice ? <p role="status" className={styles.muted}>{notice}</p> : null}
    {body}
  </SectionCard>;
}
