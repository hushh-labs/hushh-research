"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { ApiService } from "@/lib/services/api-service";

import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";

import { MailFollowupsWorkspace } from "./mail-followups-workspace";

import { MailActionButton } from "./mail-action-button";

export function MailFollowupsEntry(
  props: ComponentProps<typeof MailFollowupsWorkspace>,
) {
  const { session, onBack } = props;
  const [placement, setPlacement] = useState<"private" | "shared" | "error">();
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
  }, [session.userId, session.vaultOwnerToken]);
  if (placement === "private") return <MailFollowupsWorkspace {...props} />;

  return (
    <>
      <MailActionButton onClick={onBack}>Back to Mail</MailActionButton>
      <p role="status">
        {placement === "shared"
          ? "Mail Follow-ups requires a connected private agent."
          : placement === "error"
            ? "Mail could not verify access to this mailbox. Reopen Follow-ups to try again."
            : "Loading mailbox…"}
      </p>
    </>
  );
}
