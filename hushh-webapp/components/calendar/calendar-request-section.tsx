"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { NOT_CONNECTED_HINT } from "./calendar-insights-presentation";
import { RequestRecoveryPanel } from "./calendar-request-recovery";
import { choiceKinds, type RequestChoice, type RequestKind, type useMeetingRequest } from "./use-meeting-request";
import styles from "./calendar-insights.module.css";

const WORDS: Record<RequestKind, string> = { recording: "Recording", notes: "Notes" };

/**
 * Ask the organizer for a missing recording or notes. Ask is available as soon
 * as a type is chosen; there is no connection pre-check. A connected requester
 * never sees anything about connecting. The server resolves the organizer among
 * the requester's own connections when Ask is tapped: a connected organizer gets
 * the request in their One Feed, and otherwise nothing is sent and one quiet line
 * below Ask links to Connect (`onConnect` first remembers the meeting, so they
 * come back to it). There is no Connect button and no copy fallback.
 *
 * `offered` is what is still outstanding: files not yet verified, not already
 * asked for, and not already answered by the organizer.
 */
export function CalendarRequestSection({ request, offered, statusText, copyText, contextGuard, onConnect }: {
  request: ReturnType<typeof useMeetingRequest>; offered: readonly RequestKind[]; statusText: string | null;
  copyText: string; contextGuard: () => () => boolean; onConnect: () => void;
}) {
  const { choice, busy, notice, notConnected, failure } = request;
  const only = offered.length === 1 ? offered[0] : null;
  const selected: RequestChoice | null = only ?? (choice && choiceKinds(choice).every(kind => offered.includes(kind)) ? choice : null);
  const options = [
    ...offered.map(kind => ({ value: kind, label: WORDS[kind] })),
    ...(offered.length === 2 ? [{ value: "both", label: "Both" }] : []),
  ];
  const form = offered.length ? <div className="space-y-3">
    {only ? null : <>
      <p id="calendar-request-question">What would you like to request?</p>
      <SegmentedTabs variant="filter" ariaLabel="What would you like to request?" value={selected ?? ""}
        onValueChange={value => request.choose(value as RequestChoice)} options={options} disabled={busy} />
    </>}
    <Button disabled={!selected || busy} onClick={() => void request.ask(offered)}>{busy ? "Asking…" : "Ask organizer"}</Button>
    {notConnected ? <p className={styles.muted}>
      <Link href={ROUTES.CONNECT} className="underline" onClick={onConnect}>{NOT_CONNECTED_HINT}</Link></p> : null}
  </div> : null;
  return <SectionCard title="Recording or notes?">
    {statusText ? <p role="status">{statusText}</p> : null}
    {notice ? <p role="status" className={styles.muted}>{notice}</p> : null}
    {form}
    {failure ? <RequestRecoveryPanel recovery={failure} copyText={copyText} contextGuard={contextGuard} onClose={request.close} /> : null}
  </SectionCard>;
}
