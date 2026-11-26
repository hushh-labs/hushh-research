"use client";

import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { ApiService } from "@/lib/services/api-service";
import { mailFollowupsClient } from "@/lib/services/mail-followups-service";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
import type { FollowupMailbox } from "@/lib/mail/mail-followup-model";
import { MailFollowupsWorkspace } from "./mail-followups-workspace";
import { MailFollowupsScreen } from "./mail-followups-screen";
import { MailActionButton } from "./mail-action-button";

export function MailFollowupsEntry(
  props: ComponentProps<typeof MailFollowupsWorkspace> & {
    expectedAccount?: string | null;
  },
) {
  const { session, expectedAccount, onBack } = props;
  const mail = useMemo(
    () => mailFollowupsClient(session.vaultOwnerToken),
    [session.vaultOwnerToken],
  );
  const [placement, setPlacement] = useState<"private" | "shared" | "error">();
  const [shared, setShared] = useState<FollowupMailbox>();
  useEffect(() => {
    const controller = new AbortController();
    const epoch = snapshotVaultSessionEpoch();
    const current = () =>
      !controller.signal.aborted && isVaultSessionEpochCurrent(epoch);
    setPlacement(undefined);
    setShared(undefined);
    async function load() {
      const { hostingMode } =
        await ApiService.getPersonalAgentStatusForRouting();
      if (!current()) return;
      if (hostingMode === "byoc" || hostingMode === "hussh_pods") {
        setPlacement("private");
        return;
      }
      if (hostingMode !== "shared") throw new Error("Unknown mailbox hosting.");
      const box = await mail.inventory(controller.signal);
      if (!current()) return;
      if (expectedAccount && expectedAccount !== box.account)
        throw new Error("Mailbox changed.");
      setShared(box);
      setPlacement("shared");
    }
    void load().catch(() => {
      if (current()) setPlacement("error");
    });
    return () => controller.abort();
  }, [mail, session.userId, expectedAccount]);
  if (placement === "private") return <MailFollowupsWorkspace {...props} />;
  if (placement === "shared" && shared)
    return (
      <MailFollowupsScreen
        key={shared.connection}
        mail={mail}
        session={session}
        account={shared.account}
        connection={shared.connection}
        onBack={onBack}
      />
    );
  return (
    <>
      <MailActionButton onClick={onBack}>Back to Mail</MailActionButton>
      <p role="status">
        {placement === "error"
          ? "Mail could not verify access to this mailbox. Reopen Follow-ups to try again."
          : "Loading mailbox…"}
      </p>
    </>
  );
}
