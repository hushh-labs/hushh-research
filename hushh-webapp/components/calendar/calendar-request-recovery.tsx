"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { buildInviteToOneShare } from "@/lib/connect/invite-to-one";
import { ROUTES } from "@/lib/navigation/routes";
import { isShareCancellationError, ShareUnavailableError, shareLink } from "@/lib/share/share-link";
import { copyToClipboard } from "@/lib/utils/clipboard";
import type { RequestRecovery } from "./calendar-insights-presentation";
import styles from "./calendar-insights.module.css";

const REQUEST_FIELD = "w-full rounded border p-2";

/**
 * What a requester can do after a meeting file request fails: Connect, Invite
 * or Copy for a terminal refusal, and Copy as a last resort for a retryable one.
 * `contextGuard` snapshots the current meeting and returns a check that is false
 * once the person has moved to another one, so a late result never lands there.
 */
export function RequestRecoveryPanel({ recovery, copyText, onClose, contextGuard }: {
  recovery: RequestRecovery; copyText: string; onClose: () => void; contextGuard: () => () => boolean;
}) {
  const [note, setNote] = useState("");
  const copy = async () => {
    const current = contextGuard();
    const copied = await copyToClipboard(copyText, current);
    if (current()) setNote(copied ? "Request copied. Paste it into a message to the organizer." : "Couldn't copy automatically. Select the text above and copy it.");
  };
  const invite = async () => {
    const share = buildInviteToOneShare();
    if (!share) return;
    const current = contextGuard();
    try {
      const delivery = await shareLink(share);
      if (current() && delivery === "copied") setNote("Invite link copied.");
    } catch (failure) {
      if (isShareCancellationError(failure) || !current()) return;
      setNote(failure instanceof ShareUnavailableError ? "This browser can't share links." : "Couldn't share the invite.");
    }
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
      {recovery.connect ? <Button asChild variant="outline"><Link href={ROUTES.CONNECT}>Connect</Link></Button> : null}
      {recovery.invite && buildInviteToOneShare() ? <Button variant="outline" onClick={() => void invite()}>Invite to One</Button> : null}
      {recovery.copy ? <Button variant="outline" onClick={() => void copy()}>Copy request</Button> : null}
      <Button variant="ghost" onClick={onClose}>Close</Button>
    </div>
    {noteLine}
  </div>;
}
