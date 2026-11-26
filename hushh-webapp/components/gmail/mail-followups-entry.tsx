"use client";

import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { ApiService } from "@/lib/services/api-service";
import { mailFollowupsClient } from "@/lib/services/mail-followups-service";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";

import { MailFollowupsWorkspace } from "./mail-followups-workspace";

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
  const shared = useMemo(
    () => ({
      mail,
      async load(signal: AbortSignal) {
        const { default: primary, additional } = await mail.inventory(signal);
        if (primary && expectedAccount && expectedAccount !== primary.account)
          throw new Error("Mailbox changed.");
        return [...(primary ? [primary] : []), ...additional].map((box) => ({
          accountId: box.account,
          credentialId: box.connection,
          email: box.address,
          capabilities: { read: true, manage: false },
          isDefault: box === primary,
        }));
      },
      remove: mail.disconnectShared,
    }),
    [mail, expectedAccount],
  );
  useEffect(() => {
    const controller = new AbortController();
    const epoch = snapshotVaultSessionEpoch();
    const current = () =>
      !controller.signal.aborted && isVaultSessionEpochCurrent(epoch);
    setPlacement(undefined);

    async function load() {
      const { hostingMode } =
        await ApiService.getPersonalAgentStatusForRouting();
      if (!current()) return;
      if (hostingMode === "byoc" || hostingMode === "hussh_pods") {
        setPlacement("private");
        return;
      }
      if (hostingMode !== "shared") throw new Error("Unknown mailbox hosting.");
      setPlacement("shared");
    }
    void load().catch(() => {
      if (current()) setPlacement("error");
    });
    return () => controller.abort();
  }, [mail, session.userId, expectedAccount]);
  if (placement === "private") return <MailFollowupsWorkspace {...props} />;
  if (placement === "shared")
    return <MailFollowupsWorkspace {...props} shared={shared} />;
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
