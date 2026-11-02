"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { NOT_CONNECTED_HINT, PENDING_CONNECTION_TEXT } from "./calendar-insights-presentation";
import { RequestRecoveryPanel } from "./calendar-request-recovery";
import { choiceKinds, type RequestChoice, type RequestKind, type useMeetingRequest } from "./use-meeting-request";
import styles from "./calendar-insights.module.css";

const WORDS: Record<RequestKind, string> = { recording: "Recording", notes: "Notes" };

/**
 * Ask the organizer for a missing recording or notes. The same controls show
 * whether or not the requester is connected. A connected requester sees nothing
 * about connecting. An unconnected one cannot send and sees one quiet line below
 * Ask; tapping that line goes to Connect (`onConnect` first remembers the meeting,
 * so they come back to it). There is no Connect button and no copy fallback.
 *
 * `offered` is what is still outstanding: files not yet verified, not already
 * asked for, and not already answered by the organizer.
 */
export function CalendarRequestSection({ request, offered, statusText, copyText, contextGuard, onConnect }: {
  request: ReturnType<typeof useMeetingRequest>; offered: readonly RequestKind[]; statusText: string | null;
  copyText: string; contextGuard: () => () => boolean; onConnect: () => void;
}) {
  const { readiness, choice, busy, notice, failure } = request;
  const only = offered.length === 1 ? offered[0] : null;
  const selected: RequestChoice | null = only ?? (choice && choiceKinds(choice).every(kind => offered.includes(kind)) ? choice : null);
  const blocked = readiness.state === "not_connected" || readiness.state === "pending" || readiness.state === "refused";
  const options = [
    ...offered.map(kind => ({ value: kind, label: WORDS[kind] })),
    ...(offered.length === 2 ? [{ value: "both", label: "Both" }] : []),
  ];
  let hint: string | null = null;
  if (readiness.state === "pending") hint = PENDING_CONNECTION_TEXT;
  else if (readiness.state === "locked") hint = "Unlock your vault to ask the organizer.";
  const form = offered.length ? <div className="space-y-3">
    {only ? null : <>
      <p id="calendar-request-question">What would you like to request?</p>
      <SegmentedTabs variant="filter" ariaLabel="What would you like to request?" value={selected ?? ""}
        onValueChange={value => request.choose(value as RequestChoice)} options={options} disabled={busy} />
    </>}
    <Button disabled={!selected || busy || blocked} onClick={() => void request.ask(offered)}>{busy ? "Asking…" : "Ask organizer"}</Button>
    {hint ? <p role="status" className={styles.muted}>{hint}</p> : null}
    {readiness.state === "not_connected" ? <p className={styles.muted}>
      <Link href={ROUTES.CONNECT} className="underline" onClick={onConnect}>{NOT_CONNECTED_HINT}</Link></p> : null}
    {readiness.state === "failed" ? <p role="status" className={styles.muted}>
      Couldn&apos;t check right now. <button type="button" className="underline" onClick={request.recheck}>Try again</button></p> : null}
  </div> : null;
  const refusal = readiness.state === "refused" ? readiness.recovery : null;
  return <SectionCard title="Recording or notes?">
    {statusText ? <p role="status">{statusText}</p> : null}
    {notice ? <p role="status" className={styles.muted}>{notice}</p> : null}
    {refusal ? <RequestRecoveryPanel recovery={refusal} copyText={copyText} contextGuard={contextGuard} /> : form}
    {failure ? <RequestRecoveryPanel recovery={failure} copyText={copyText} contextGuard={contextGuard} onClose={request.close} /> : null}
  </SectionCard>;
}
