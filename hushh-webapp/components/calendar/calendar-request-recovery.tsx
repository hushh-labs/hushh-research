"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/utils/clipboard";
import type { RequestRecovery } from "./calendar-insights-presentation";
import styles from "./calendar-insights.module.css";

const REQUEST_FIELD = "w-full rounded border p-2";

/**
 * What a requester can do when a meeting file request cannot be sent for a reason
 * other than the connection (a connection problem is only ever a quiet hint below
 * Ask organizer). Copy is offered for refusals where One cannot send for the
 * person, and as a last resort when sending keeps failing. `contextGuard`
 * snapshots the current meeting and returns a check that is false once the person
 * has moved to another one, so a late result never lands there.
 */
export function RequestRecoveryPanel({ recovery, copyText, onClose, contextGuard }: {
  recovery: RequestRecovery; copyText: string; onClose?: () => void; contextGuard: () => () => boolean;
}) {
  const [note, setNote] = useState("");
  const copy = async () => {
    const current = contextGuard();
    const copied = await copyToClipboard(copyText, current);
    if (current()) setNote(copied ? "Request copied. Paste it into a message to the organizer." : "Couldn't copy automatically. Select the text above and copy it.");
  };
  const noteLine = note ? <p role="status" className={styles.muted}>{note}</p> : null;
  const field = <textarea readOnly aria-label="Request to send to the organizer" className={REQUEST_FIELD} rows={4} value={copyText} />;
  if (recovery.tone === "retry") return recovery.copy ? <div className="space-y-2">
    <p>If this keeps failing, copy this request and send it directly.</p>
    {field}
    <Button variant="outline" onClick={() => void copy()}>Copy request</Button>
    {noteLine}
  </div> : null;
  return <div className="space-y-3" data-testid="calendar-request-recovery">
    <p role="alert">{recovery.message}</p>
    {recovery.copy ? field : null}
    <div className="flex flex-wrap gap-2">
      {recovery.copy ? <Button variant="outline" onClick={() => void copy()}>Copy request</Button> : null}
      {onClose ? <Button variant="ghost" onClick={onClose}>Close</Button> : null}
    </div>
    {noteLine}
  </div>;
}
