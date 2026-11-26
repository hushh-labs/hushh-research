"use client";

import { useEffect, useRef, useState } from "react";
import { MailFollowupsScreen } from "./mail-followups-screen";
import { MailActionButton } from "./mail-action-button";
import { privateMailAccounts, disconnectPrivateMailAccount, type PrivateMailAccount } from "@/lib/services/private-google-connections";
import { connectGoogleConnector, connectRefusalMessage, type GoogleConnectorTransitionReview } from "@/lib/one/google-native-connect";
import { requestGoogleConnectorPhoneHandoff } from "@/lib/one/google-connector-intent";
import type { TodoWriteParams } from "@/lib/services/todo-list-pkm-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function MailFollowupsWorkspace({ session, onBack, confirmTransition }: {
  session: TodoWriteParams; onBack: () => void; confirmTransition: (terms: GoogleConnectorTransitionReview) => Promise<boolean>;
}) {
  const [accounts, setAccounts] = useState<PrivateMailAccount[]>();
  const [choice, setChoice] = useState<string>();
  const [disconnect, setDisconnect] = useState<PrivateMailAccount>();
  const [revision, refresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const epoch = snapshotVaultSessionEpoch();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && isVaultSessionEpochCurrent(epoch);
  useEffect(() => {
    let live = true;
    privateMailAccounts().then(value => { if (live && isVaultSessionEpochCurrent(epoch)) {setAccounts(value); setError("");} })
      .catch(() => { if (live) {setAccounts(undefined); setError("Mail could not load your connected accounts.");} });
    return () => { live = false; };
  }, [revision, epoch]);
  const active = accounts?.filter(account => account.capabilities.read);
  const selected = active?.find(account => account.accountId === choice) ?? active?.find(account => account.isDefault) ?? active?.[0];
  async function add() {
    setBusy(true);
    try {
      const outcome = await connectGoogleConnector("gmail", { isCurrent: current, mailAccount: { mode: "add" },
        vaultOwnerCapability: session.vaultOwnerToken, confirmLegacyTransition: confirmTransition });
      if (!current()) return;
      if (outcome.ok) refresh(n => n + 1);
      else if (outcome.code === "PHONE_HANDOFF_REQUIRED") requestGoogleConnectorPhoneHandoff("gmail", undefined, false, true);
      else setError(connectRefusalMessage(outcome.code, "Mail"));
    } catch { if (current()) setError("Could not add the Google account."); }
    finally { if (current()) setBusy(false); }
  }
  async function remove(account: PrivateMailAccount) {
    setBusy(true);
    try {
      const result = await disconnectPrivateMailAccount(account.accountId, account.credentialId);
      if (!current()) return;
      if (result.disconnected) setAccounts(rows => rows?.filter(row => row.credentialId !== account.credentialId));
      setDisconnect(undefined); refresh(n => n + 1);
    } catch { if (current()) setError("Mail could not confirm the disconnect."); }
    finally { if (current()) setBusy(false); }
  }
  return <section aria-label="Mail follow-up workspace">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <DropdownMenu><DropdownMenuTrigger asChild><MailActionButton aria-label="Choose mailbox">{selected?.email || "Choose mailbox"}</MailActionButton></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuRadioGroup value={selected?.accountId} onValueChange={id => { setChoice(id); setDisconnect(undefined); }}>
          {active?.map(account => <DropdownMenuRadioItem key={account.accountId} value={account.accountId}>{account.email || "Connected mailbox"}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
      <MailActionButton disabled={busy} onClick={add}>Add Google account</MailActionButton>
      {selected && <MailActionButton disabled={busy} onClick={() => setDisconnect(selected)}>Disconnect mailbox</MailActionButton>}
    </div>
    {disconnect && <div role="group" aria-label="Confirm disconnect"><p>Disconnect {disconnect.email || "this mailbox"}?</p>
      <MailActionButton disabled={busy} onClick={() => remove(disconnect)}>Confirm disconnect</MailActionButton>
      <MailActionButton disabled={busy} onClick={() => setDisconnect(undefined)}>Cancel</MailActionButton></div>}
    {error && <div role="alert">{error} <MailActionButton onClick={() => refresh(n => n + 1)}>Refresh</MailActionButton></div>}
    {selected ? <MailFollowupsScreen key={selected.credentialId} account={selected.accountId} connection={selected.credentialId}
      session={session} onBack={onBack}/> : <><MailActionButton onClick={onBack}>Back to Mail</MailActionButton>
      {!error && <p role="status">{accounts ? "Connect a mailbox to track a conversation." : "Loading mailboxes…"}</p>}</>}
  </section>;
}
