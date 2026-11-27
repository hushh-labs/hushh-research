"use client";

import { useEffect, useRef, useState } from "react";
import { MailFollowupsScreen } from "./mail-followups-screen";
import { useSettledMailTasks } from "./mail-followups-session-watch";
import { MailActionButton } from "./mail-action-button";
import {
  privateMailAccounts,
  disconnectPrivateMailAccount,
  type PrivateMailAccount,
} from "@/lib/services/private-google-connections";
import {
  connectGoogleConnector,
  connectRefusalMessage,
  type GoogleConnectorTransitionReview,
} from "@/lib/one/google-native-connect";
import { requestGoogleConnectorPhoneHandoff } from "@/lib/one/google-connector-intent";
import {
  TodoListPkmService,
  type TodoItem,
  type TodoWriteParams,
} from "@/lib/services/todo-list-pkm-service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

import { MailFollowupsBoard } from "./mail-followups-board";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import type { FollowupMailbox } from "@/lib/mail/mail-followup-model";

function AllMailBoard({
  mail,
  accounts,
  session,
  onTask,
  onTrack,
  onBack,
}: {
  mail: typeof MailFollowupsService;
  accounts: PrivateMailAccount[];
  session: TodoWriteParams;
  onTrack: () => void;
  onBack: () => void;
  onTask: (id: string, action: "evidence" | "plan", account: string) => void;
}) {
  const [data, setData] = useState<{
    boxes: FollowupMailbox[];
    tasks: TodoItem[];
  }>();
  const [failed, setFailed] = useState(false);
  const { userId, vaultKey, vaultOwnerToken } = session;
  useEffect(() => {
    const controller = new AbortController();
    const epoch = snapshotVaultSessionEpoch();
    setData(undefined);
    setFailed(false);
    Promise.all([
      Promise.all(
        accounts
          .filter((a) => a.capabilities.read)
          .map((a) =>
            mail.account(a.accountId, a.credentialId, controller.signal),
          ),
      ),
      TodoListPkmService.load({ userId, vaultKey, vaultOwnerToken }),
    ])
      .then(([boxes, rows]) => {
        if (!controller.signal.aborted && isVaultSessionEpochCurrent(epoch))
          setData({ boxes, tasks: rows.tasks });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [mail, accounts, userId, vaultKey, vaultOwnerToken]);
  useSettledMailTasks(session, (rows) => {
    setData((previous) => previous && { ...previous, tasks: rows });
  });
  return (
    <>
      <MailActionButton onClick={onBack}>Back to Mail</MailActionButton>
      {data ? (
        <MailFollowupsBoard
          mailboxes={data.boxes}
          tasks={data.tasks}
          onTrack={onTrack}
          onEvidence={(item) => onTask(item.key, "evidence", item.account)}
          onAction={(task) =>
            onTask(task.mailFollowup!.key, "plan", task.mailFollowup!.account)
          }
        />
      ) : (
        <p role="status">
          {failed
            ? "All Mail could not load every connected mailbox. Choose a mailbox to continue."
            : "Loading mailboxes…"}
        </p>
      )}
    </>
  );
}

export function MailFollowupsWorkspace({
  session,
  onBack,
  confirmTransition,
}: {
  session: TodoWriteParams;
  onBack: () => void;
  confirmTransition: (
    terms: GoogleConnectorTransitionReview,
  ) => Promise<boolean>;
}) {
  const mail = MailFollowupsService;
  const [accounts, setAccounts] = useState<PrivateMailAccount[]>();
  const [handoff, setHandoff] = useState<{
    key: string;
    action: "evidence" | "plan";
  }>();
  const [pickTrack, setPickTrack] = useState(false);
  const [choice, setChoice] = useState<string>();
  const [disconnect, setDisconnect] = useState<PrivateMailAccount>();
  const [revision, refresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const epoch = snapshotVaultSessionEpoch();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && isVaultSessionEpochCurrent(epoch);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    privateMailAccounts()
      .then((value) =>
        Promise.all(
          value.map(async (account) => {
            if (account.email || !account.capabilities.read) return account;
            const box = await mail.account(
              account.accountId,
              account.credentialId,
              controller.signal,
            );
            return { ...account, email: box.address };
          }),
        ),
      )
      .then((value) => {
        if (live && isVaultSessionEpochCurrent(epoch)) {
          setAccounts(value);
          setError("");
        }
      })
      .catch(() => {
        if (live) {
          setAccounts(undefined);
          setError("Mail could not load your connected accounts.");
        }
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [revision, epoch, mail]);
  const active = accounts?.filter((account) => account.capabilities.read);
  const all = choice === "all" && Boolean(active?.length);
  const selected =
    choice ? active?.find((account) => account.accountId === choice)
      : active?.find((account) => account.isDefault) ?? active?.[0];
  async function add() {
    setBusy(true);
    try {
      const outcome = await connectGoogleConnector("gmail", {
        isCurrent: current,
        mailAccount: { mode: "add" },
        vaultOwnerCapability: session.vaultOwnerToken,
        confirmLegacyTransition: confirmTransition,
      });
      if (!current()) return;
      if (outcome.ok) refresh((n) => n + 1);
      else if (outcome.code === "PHONE_HANDOFF_REQUIRED")
        requestGoogleConnectorPhoneHandoff("gmail", undefined, false, true);
      else setError(connectRefusalMessage(outcome.code, "Mail"));
    } catch {
      if (current()) setError("Could not add the Google account.");
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function remove(account: PrivateMailAccount) {
    setBusy(true);
    try {
      const result = await disconnectPrivateMailAccount(
        account.accountId,
        account.credentialId,
      );
      if (!current()) return;
      if (result.disconnected)
        setAccounts((rows) =>
          rows?.filter((row) => row.credentialId !== account.credentialId),
        );
      setDisconnect(undefined);
      refresh((n) => n + 1);
    } catch {
      if (current()) setError("Mail could not confirm the disconnect.");
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <section aria-label="Mail follow-up workspace">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select
          aria-label="Choose mailbox"
          className="rounded-xl border bg-background px-3 py-2"
          value={all ? "all" : selected?.accountId || ""}
          onChange={(event) => {
            setHandoff(undefined);
            setPickTrack(false);
            setChoice(event.target.value);
            setDisconnect(undefined);
          }}
        >
          {!selected && <option value="">Choose mailbox</option>}
          {Boolean(active?.length) && <option value="all">All Mail</option>}
          {active?.map((account) => (
            <option key={account.accountId} value={account.accountId}>
              {account.email || "Connected mailbox"}
            </option>
          ))}
        </select>
        <MailActionButton disabled={busy} onClick={add}>
          Add Google account
        </MailActionButton>
        {selected && !all && (
          <MailActionButton
            disabled={busy}
            onClick={() => setDisconnect(selected)}
          >
            Disconnect mailbox
          </MailActionButton>
        )}
      </div>
      {disconnect && (
        <div role="group" aria-label="Confirm disconnect">
          <p>Disconnect {disconnect.email || "this mailbox"}?</p>
          <MailActionButton disabled={busy} onClick={() => remove(disconnect)}>
            Confirm disconnect
          </MailActionButton>
          <MailActionButton
            disabled={busy}
            onClick={() => setDisconnect(undefined)}
          >
            Cancel
          </MailActionButton>
        </div>
      )}
      {error && (
        <div role="alert">
          {error}{" "}
          <MailActionButton onClick={() => refresh((n) => n + 1)}>
            Refresh
          </MailActionButton>
        </div>
      )}
      {all && accounts ? (
        <>
          <AllMailBoard
            mail={mail}
            accounts={accounts}
            session={session}
            onBack={onBack}
            onTrack={() => setPickTrack(true)}
            onTask={(key, action, account) => {
              setHandoff({ key, action });
              setChoice(account);
            }}
          />
          {pickTrack && (
            <p>Choose the mailbox containing the conversation to track.</p>
          )}
        </>
      ) : selected ? (
        <MailFollowupsScreen
          mail={mail}
          handoff={handoff}
          key={selected.credentialId}
          account={selected.accountId}
          connection={selected.credentialId}
          verifiedAddress={selected.email ?? undefined}
          session={session}
        />
      ) : (
        <>
          <MailActionButton onClick={onBack}>Back to Mail</MailActionButton>
          {!error && (
            <p role="status">
              {accounts
                ? active?.length ? "Choose a mailbox to continue." : "Connect a mailbox to track a conversation."
                : "Loading mailboxes…"}
            </p>
          )}
        </>
      )}
    </section>
  );
}
