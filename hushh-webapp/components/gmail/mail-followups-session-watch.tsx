"use client";

import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import type { FollowupMailbox } from "@/lib/mail/mail-followup-model";
import { ApiService } from "@/lib/services/api-service";
import { MailFollowupsService as mail } from "@/lib/services/mail-followups-service";
import { PRIVATE_MAIL_GRANTS_CHANGED, privateMailAccounts } from "@/lib/services/private-google-connections";
import {
  MAIL_FOLLOWUP_TEMPLATE,
  PodScheduledTasksClient,
} from "@/lib/services/pod-scheduled-tasks";
import {
  TODO_LIST_PKM_DOMAIN,
  TodoListPkmService as tasks,
  type TodoItem,
  type TodoWriteParams,
} from "@/lib/services/todo-list-pkm-service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

/** Refresh open boards without reopening the conversation or touching the editor. */
export function useSettledMailTasks(session: TodoWriteParams, onChange: (rows: TodoItem[]) => void) {
  const publish = useEffectEvent(onChange);
  const { userId, vaultKey, vaultOwnerToken } = session;
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, snapshotVaultSessionEpoch);
  useEffect(() => {
    let sequence = 0;
    function refresh() {
      const request = ++sequence;
      void tasks.load({ userId, vaultKey, vaultOwnerToken })
        .then(({ tasks: rows }) => {
          if (request === sequence && isVaultSessionEpochCurrent(epoch)) publish(rows);
        })
        .catch(() => { /* Leave the last authorized task snapshot on screen. */ });
    }
    const unsubscribe = subscribeToPkmDomainChanges(({ userId: owner, domain }) => {
      if (owner === userId && (domain === TODO_LIST_PKM_DOMAIN || domain === "*")) refresh();
    });
    return () => {
      ++sequence;
      unsubscribe();
    };
  }, [userId, vaultKey, vaultOwnerToken, epoch]);
}

export async function checkMailFollowup(
  session: TodoWriteParams,
  task: TodoItem,
  box: FollowupMailbox,
  scheduler: PodScheduledTasksClient,
  signal: AbortSignal,
  client: typeof mail = mail,
) {
  const item = task.mailFollowup;
  if (!item || task.status !== "pending") return false;
  if (item.account !== box.account || item.connection !== box.connection)
    throw new Error("Mailbox changed.");

  const epoch = snapshotVaultSessionEpoch();
  const current = () => !signal.aborted && isVaultSessionEpochCurrent(epoch);
  const ensureCurrent = () => {
    if (!current()) throw new DOMException("Session changed", "AbortError");
  };
  ensureCurrent();
  const found = await client.check(box, item, signal);
  ensureCurrent();
  if (!found.source) return false;
  async function ensureGrant() {
    ensureCurrent();
    const accounts = await privateMailAccounts(signal);
    ensureCurrent();
    if (!accounts.some((grant) => grant.capabilities.read &&
      grant.accountId === box.account && grant.credentialId === box.connection))
      throw new Error("Mailbox access changed.");
  }
  await ensureGrant();

  // A scheduled outgoing email, if there is one, belongs to this exact watch.
  if (item.scheduleId) {
    const saved = await tasks.load(session);
    ensureCurrent();
    if (!saved.tasks.some((row) => row.id === task.id && row.revision === task.revision &&
      row.status === "pending" && row.mailFollowup?.scheduleId === item.scheduleId))
      throw new Error("The task changed. Reopen Follow-ups.");
    const status = await scheduler.status(signal);
    ensureCurrent();
    const scheduled = status.tasks.find(
      (row) => row.id === item.scheduleId && row.capability === MAIL_FOLLOWUP_TEMPLATE,
    );
    if (!scheduled) throw new Error("Could not verify the scheduled follow-up.");
    if (scheduled.state === "cancelling")
      throw new Error("Mail is waiting for cancellation to finish.");
    if (scheduled.state !== "completed" && scheduled.state !== "cancelled") {
      await ensureGrant();
      const updated = await scheduler.control(scheduled, "cancel", signal);
      ensureCurrent();
      if (updated.state !== "cancelled")
        throw new Error("Mail is waiting for cancellation to finish.");
    }
  }

  const result = await tasks.updateMail(session, task, {
    received: { source: found.source, filename: found.filename },
  }, current, ensureGrant);
  ensureCurrent();
  if (!result.success) throw new Error("The task changed. Reopen Follow-ups.");
  return true;
}

async function checkWatchedTasks(session: TodoWriteParams, signal: AbortSignal) {
  signal.throwIfAborted();
  const { tasks: saved } = await tasks.load(session);
  signal.throwIfAborted();
  const watched = saved.filter((task) =>
    task.sourceAgent === "gmail" && task.status === "pending" && task.mailFollowup?.watching,
  );
  if (!watched.length) return false;

  const { hostingMode } = await ApiService.getPersonalAgentStatusForRouting({ signal });
  signal.throwIfAborted();
  if (hostingMode !== "byoc" && hostingMode !== "hussh_pods") return true;
  const accounts = await privateMailAccounts(signal);
  signal.throwIfAborted();
  const scheduler = new PodScheduledTasksClient(session.userId);

  for (const account of accounts) {
    if (!account.capabilities.read) continue;
    const pending = watched.filter(({ mailFollowup }) =>
      mailFollowup?.account === account.accountId && mailFollowup.connection === account.credentialId,
    );
    if (!pending.length) continue;
    let box: FollowupMailbox;
    try {
      box = await mail.account(account.accountId, account.credentialId, signal);
      signal.throwIfAborted();
      if (box.account !== account.accountId || box.connection !== account.credentialId) continue;
    } catch {
      signal.throwIfAborted();
      continue; // A disconnected mailbox must not block other authorized watches.
    }
    for (const task of pending) {
      signal.throwIfAborted();
      try {
        await checkMailFollowup(session, task, box, scheduler, signal);
      } catch {
        signal.throwIfAborted();
        // Leave the task pending: grant, revision or provider errors can be retried.
      }
    }
  }
  return true;
}

/** Mounted for an unlocked owner session, independent of the current One route. */
export function MailFollowupsSessionWatch({ session }: { session: TodoWriteParams }) {
  const { userId, vaultKey, vaultOwnerToken } = session;
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, snapshotVaultSessionEpoch);
  useEffect(() => {
    let disposed = false;
    let noWatches = false;
    let changeVersion = 0;
    let flight: AbortController | undefined;
    function refresh() {
      if (disposed || flight || noWatches || document.visibilityState === "hidden" || !isVaultSessionEpochCurrent(epoch)) return;
      const controller = new AbortController();
      flight = controller;
      const started = changeVersion;
      void checkWatchedTasks({ userId, vaultKey, vaultOwnerToken }, controller.signal)
        .then((hasWatches) => {
          if (!controller.signal.aborted && started === changeVersion) noWatches = !hasWatches;
        })
        .catch(() => { /* No side effects on read failure. Retry on next tick. */ })
        .finally(() => { if (flight === controller) flight = undefined; });
    }
    function interrupt() {
      flight?.abort();
      flight = undefined;
    }
    function wake() {
      changeVersion += 1;
      noWatches = false;
      refresh();
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") interrupt();
      else wake();
    }
    const stopTaskChanges = subscribeToPkmDomainChanges(({ userId: owner, domain }) => {
      if (owner === userId && (domain === TODO_LIST_PKM_DOMAIN || domain === "*")) {
        interrupt();
        wake();
      }
    });
    const unsubscribe = subscribeVaultSessionEpoch(interrupt);
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(PRIVATE_MAIL_GRANTS_CHANGED, interrupt);
    window.addEventListener("pageshow", wake);
    window.addEventListener("pagehide", interrupt);
    refresh();
    return () => {
      disposed = true;
      interrupt();
      unsubscribe();
      stopTaskChanges();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(PRIVATE_MAIL_GRANTS_CHANGED, interrupt);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("pagehide", interrupt);
    };
  }, [userId, vaultKey, vaultOwnerToken, epoch]);
  return null;
}
