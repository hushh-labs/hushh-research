"use client";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { RequestRecoveryPanel } from "./calendar-request-recovery";
import { choiceKinds, type RequestChoice, type RequestKind, type useMeetingRequest } from "./use-meeting-request";
import styles from "./calendar-insights.module.css";

const WORDS: Record<RequestKind, string> = { recording: "Recording", notes: "Notes" };

/**
 * Ask the organizer for a missing recording or notes. Ask is available as soon
 * as a type is chosen; there is no connection pre-check, hint or Connect link.
 * The server resolves the organizer among the requester's own connections when
 * Ask is tapped: a connected organizer gets the request in their One Feed, and
 * otherwise nothing is sent and the notice below says so.
 *
 * `offered` is what is still outstanding: files not yet verified, not already
 * asked for, and not already answered by the organizer.
 */
export function CalendarRequestSection({ request, offered, statusText, copyText, contextGuard }: {
  request: ReturnType<typeof useMeetingRequest>; offered: readonly RequestKind[]; statusText: string | null;
  copyText: string; contextGuard: () => () => boolean;
}) {
  const { choice, busy, notice, failure } = request;
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
  </div> : null;
  return <SectionCard title="Recording or notes?">
    {statusText ? <p role="status">{statusText}</p> : null}
    {notice ? <p role="status" className={styles.muted}>{notice}</p> : null}
    {form}
    {failure ? <RequestRecoveryPanel recovery={failure} copyText={copyText} contextGuard={contextGuard} onClose={request.close} /> : null}
  </SectionCard>;
}
