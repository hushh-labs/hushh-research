"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  MailFollowupsService,
  PrivateMailReplyService,
  privateTopicsSchema,
  type PrivateMailTopic,
  type PreparedMailReply,
  type PrivateOverviewBrief,
  type PrivateOverviewRows,
  type PrivateOverviewThread,
} from "@/lib/services/mail-followups-service";
import { PrivateMailStateService } from "@/lib/services/private-mail-state-service";
import type { PrivateMailAccount } from "@/lib/services/private-google-connections";
import { TodoListPkmService, type TodoWriteParams } from "@/lib/services/todo-list-pkm-service";
import { useSettledMailTasks } from "./mail-followups-session-watch";
import { MailActionButton as Button } from "./mail-action-button";

type Mailbox = PrivateMailAccount;
type ReadBatch<T> = { values: Array<{ mailbox: Mailbox; value: T }>; failed: number };
type Evidence = PrivateMailTopic["evidence"];
type Target = { mailbox: Mailbox; source: string; title: string; evidence?: Evidence };

const selection = (mailbox: Mailbox) => ({
  account: mailbox.accountId,
  connection: mailbox.credentialId,
});

async function readMailboxes<T>(
  accounts: Mailbox[],
  read: (mailbox: Mailbox) => Promise<T>,
  signal: AbortSignal,
): Promise<ReadBatch<T>> {
  const result: ReadBatch<T> = { values: [], failed: 0 };
  for (let index = 0; index < accounts.length; index += 3) {
    signal.throwIfAborted();
    const group = accounts.slice(index, index + 3);
    const settled = await Promise.allSettled(group.map(read));
    settled.forEach((entry, offset) => {
      if (entry.status === "fulfilled") result.values.push({ mailbox: group[offset]!, value: entry.value });
      else result.failed += 1;
    });
  }
  return result;
}

function BriefSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2.5">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function OverviewCard({
  title, reason, mailbox, action, onOpen,
}: { title: string; reason?: string; mailbox?: string | null; action: string; onOpen: () => void }) {
  return (
    <article className="rounded-xl border border-border bg-card p-3.5">
      {mailbox ? <p className="truncate text-[13px] text-muted-foreground">{mailbox}</p> : null}
      <h3 className="mt-0.5 text-sm font-semibold">{title}</h3>
      {reason ? <p className="mt-1 text-sm text-muted-foreground">{reason}</p> : null}
      <Button type="button" variant="ghost" className="mt-1 min-h-11 px-2 text-sm" onClick={onOpen}>{action}</Button>
    </article>
  );
}

function MailThreadDialog({
  target, onClose, onSource,
}: { target: Target; onClose: () => void; onSource: (source: string) => void }) {
  const [thread, setThread] = useState<PrivateOverviewThread>();
  const [error, setError] = useState("");
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState<{ to: string; subject: string; body: string }>();
  const [drafting, setDrafting] = useState(false);
  const [replyReview, setReplyReview] = useState<PreparedMailReply>();
  const [sendState, setSendState] = useState<"idle" | "reviewing" | "sending" | "sent" | "unknown">("idle");
  const draftRequest = useRef<AbortController | null>(null);
  const { accountId, credentialId } = target.mailbox;

  useEffect(() => {
    const keep = new AbortController();
    void MailFollowupsService.thread({ account: accountId, connection: credentialId }, target.source, keep.signal)
      .then((value) => { if (!keep.signal.aborted) setThread(value); })
      .catch(() => { if (!keep.signal.aborted) setError("Couldn’t open this conversation."); });
    return () => keep.abort();
  }, [accountId, credentialId, target.source]);
  useEffect(() => () => draftRequest.current?.abort(), []);

  async function prepareDraft() {
    if (drafting || !instruction.trim()) return;
    const controller = new AbortController();
    draftRequest.current?.abort();
    draftRequest.current = controller;
    setDrafting(true);
    setError("");
    try {
      const result = await MailFollowupsService.draft(selection(target.mailbox), target.source, instruction.trim(), controller.signal);
      if (!controller.signal.aborted) setDraft(result);
    } catch {
      if (!controller.signal.aborted) setError("Couldn’t draft a reply to this message.");
    } finally {
      if (!controller.signal.aborted) setDrafting(false);
    }
  }

  async function reviewReply() {
    if (!target.mailbox.capabilities.manage || !draft?.body.trim() || sendState !== "idle") return;
    const controller = new AbortController();
    draftRequest.current = controller;
    setSendState("reviewing");
    setError("");
    try {
      const result = await PrivateMailReplyService.prepare(selection(target.mailbox), target.source, draft.body, controller.signal);
      if (!controller.signal.aborted) setReplyReview(result);
    } catch {
      if (!controller.signal.aborted) setError("Couldn’t prepare this reply. Check your mailbox connection and try again.");
    } finally {
      if (!controller.signal.aborted) setSendState("idle");
    }
  }

  async function sendReply() {
    if (!replyReview || sendState !== "idle") return;
    const controller = new AbortController();
    draftRequest.current = controller;
    setSendState("sending");
    setError("");
    try {
      await PrivateMailReplyService.send(replyReview.proposal_id, controller.signal);
      if (!controller.signal.aborted) setSendState("sent");
    } catch {
      if (!controller.signal.aborted) setSendState("unknown");
    }
  }

  async function checkReplyStatus() {
    if (!replyReview || sendState !== "unknown") return;
    const controller = new AbortController();
    draftRequest.current?.abort();
    draftRequest.current = controller;
    try {
      const status = await PrivateMailReplyService.status(replyReview.proposal_id, controller.signal);
      if (!controller.signal.aborted && status === "sent") setSendState("sent");
    } catch {
      if (!controller.signal.aborted) setError("Couldn’t verify the send. Check Sent in this mailbox.");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && sendState !== "sending") onClose(); }}>
      <DialogContent className="max-h-[min(85dvh,48rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{target.title || "Mail conversation"}</DialogTitle>
          <DialogDescription>{target.mailbox.email || "Selected mailbox"}</DialogDescription>
        </DialogHeader>
        {target.evidence && target.evidence.length > 1 ? (
          <ul aria-label="Source evidence" className="space-y-2">
            {target.evidence.map((item) => (
              <li key={item.source_id} className="rounded-lg border border-border p-2">
                <blockquote className="text-sm">{item.quote}</blockquote>
                <Button type="button" variant="ghost" disabled={sendState !== "idle" || Boolean(replyReview) || drafting}
                  onClick={() => onSource(item.source_id)}>
                  View email from {item.from}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {!thread && !error ? <p role="status">Opening conversation…</p> : null}
        {thread?.items.map((message) => (
          <article key={message.source} className="min-w-0 space-y-1 rounded-xl border border-border p-3">
            <p className="break-words text-sm font-semibold">{message.sender}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
            {message.body_truncated ? <p className="text-sm text-muted-foreground">Long message shortened.</p> : null}
          </article>
        ))}
        {thread?.truncated ? <p className="text-sm text-muted-foreground">Showing part of this conversation.</p> : null}
        {thread && !replyReview && sendState === "idle" ? (
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void prepareDraft(); }}>
            <Input aria-label="What should the reply say?" placeholder="What should the reply say?" value={instruction}
              maxLength={500} onChange={(event) => setInstruction(event.target.value)} />
            <Button type="submit" disabled={drafting || !instruction.trim()}>{drafting ? "Drafting…" : "Draft reply"}</Button>
          </form>
        ) : null}
        {draft && !replyReview ? (
          <section aria-label="Reply draft" className="space-y-2 rounded-xl border border-border p-3">
            <p className="break-words text-sm">To {draft.to}</p>
            <p className="text-sm font-semibold">{draft.subject}</p>
            <textarea aria-label="Reply body" className="min-h-28 w-full rounded-lg border border-border bg-background p-2 text-sm"
              value={draft.body} disabled={sendState === "reviewing"} maxLength={12000}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            {target.mailbox.capabilities.manage ? (
              <Button type="button" disabled={drafting || !draft.body.trim() || sendState === "reviewing"} onClick={() => void reviewReply()}>
                {sendState === "reviewing" ? "Preparing review…" : "Review reply"}
              </Button>
            ) : <p role="status">Reconnect this mailbox with send access to send the reply.</p>}
          </section>
        ) : null}
        {replyReview ? (
          <section aria-label="Review reply" className="space-y-2 rounded-xl border border-border p-3">
            <p className="break-words text-sm">To {replyReview.preview.to[0]}</p>
            <p className="text-sm font-semibold">{replyReview.preview.subject}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{replyReview.preview.body}</p>
            {sendState === "sent" ? <p role="status">Reply sent.</p> : sendState === "unknown" ? (
              <>
                <p role="status">The send could not be confirmed. Check Sent before sending again.</p>
                <Button type="button" variant="ghost" onClick={() => void checkReplyStatus()}>Check status</Button>
              </>
            ) : (
              <div className="flex gap-2">
                <Button type="button" variant="ghost" disabled={sendState === "sending"} onClick={() => setReplyReview(undefined)}>Edit reply</Button>
                <Button type="button" disabled={sendState === "sending"} onClick={() => void sendReply()}>
                  {sendState === "sending" ? "Sending…" : "Send reply"}
                </Button>
              </div>
            )}
          </section>
        ) : null}
        {error ? <p role="alert" className="text-sm text-muted-foreground">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

export function PrivateMailOverview({
  accounts, session, onFollowups,
}: { accounts: Mailbox[]; session: TodoWriteParams; onFollowups: () => void }) {
  const [brief, setBrief] = useState<ReadBatch<PrivateOverviewBrief>>();
  const [recent, setRecent] = useState<ReadBatch<PrivateOverviewRows>>();
  const [completed, setCompleted] = useState<Awaited<ReturnType<typeof TodoListPkmService.load>>["tasks"]>();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [target, setTarget] = useState<Target>();
  const { userId, vaultKey, vaultOwnerToken } = session;

  useEffect(() => {
    const controller = new AbortController();
    setBrief(undefined);
    void readMailboxes(accounts, (mailbox) => MailFollowupsService.brief(selection(mailbox), controller.signal), controller.signal)
      .then((value) => { if (!controller.signal.aborted) setBrief(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [accounts, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    setRecent(undefined);
    void readMailboxes(accounts, async (mailbox) => {
      const response = submitted
        ? await MailFollowupsService.searchOverview(selection(mailbox), submitted, controller.signal)
        : await MailFollowupsService.recent(selection(mailbox), controller.signal);
      return response.items;
    }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setRecent(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [accounts, submitted, attempt]);

  useEffect(() => {
    let current = true;
    void TodoListPkmService.load({ userId, vaultKey, vaultOwnerToken })
      .then(({ tasks }) => { if (current) setCompleted(tasks); })
      .catch(() => { if (current) setCompleted([]); });
    return () => { current = false; };
  }, [userId, vaultKey, vaultOwnerToken]);
  useSettledMailTasks(session, setCompleted);

  const decisions = brief?.values.flatMap(({ mailbox, value }) =>
    value.attention.map((item) => ({ mailbox, ...item }))) ?? [];
  const changes = brief?.values.flatMap(({ mailbox, value }) =>
    value.updates.map((item) => ({ mailbox, ...item })))
    .sort((a, b) => (b.evidence.at(-1)?.on ?? "").localeCompare(a.evidence.at(-1)?.on ?? "")) ?? [];
  const done = (completed ?? []).flatMap((task) => {
    const item = task.mailFollowup;
    if (task.status !== "done" || !item?.received) return [];
    const mailbox = accounts.find((account) => account.accountId === item.account && account.credentialId === item.connection);
    return mailbox ? [{ key: task.id, mailbox, source: item.received.source, title: task.title, reason: item.reason }] : [];
  }).slice(0, 5);
  const rows = recent?.values.flatMap(({ mailbox, value }) => value.map((row) => ({ mailbox, ...row }))) ?? [];
  if (!submitted) rows.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
  const displayMailbox = (mailbox: Mailbox) => accounts.length > 1 ? mailbox.email : null;

  return (
    <div className="space-y-5" aria-label="Mail overview">
      <BriefSection title="Decisions">
        {decisions.length ? (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {decisions.slice(0, 8).map((item) => (
              <OverviewCard key={item.id} title={item.title} reason={item.reason} mailbox={displayMailbox(item.mailbox)}
                action="Review email" onOpen={() => setTarget({ mailbox: item.mailbox, source: item.evidence[0]!.source_id, title: item.title, evidence: item.evidence })} />
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">{brief ? brief.failed ? "Couldn’t check decisions in every mailbox." : "No decisions found in recent mail." : "Checking recent mail…"}</p>}
        <Button type="button" variant="ghost" className="min-h-11" onClick={onFollowups}>Open Follow-ups</Button>
      </BriefSection>
      <BriefSection title="Meaningful changes">
        {changes.length ? changes.slice(0, 5).map((item) => (
          <OverviewCard key={item.id} title={item.title} reason={item.line} mailbox={displayMailbox(item.mailbox)}
            action="Review evidence" onOpen={() => setTarget({ mailbox: item.mailbox, source: item.evidence.at(-1)!.source_id, title: item.title, evidence: item.evidence })} />
        )) : <p className="text-sm text-muted-foreground">{brief ? brief.failed ? "Couldn’t check changes in every mailbox." : "No changes found in recent mail." : "Checking for changes…"}</p>}
      </BriefSection>
      <BriefSection title="Recently completed">
        {done.length ? done.map((item) => (
          <OverviewCard key={item.key} title={item.title} reason={item.reason} mailbox={displayMailbox(item.mailbox)}
            action="View email" onOpen={() => setTarget(item)} />
        )) : <p className="text-sm text-muted-foreground">{completed ? "No completed Mail follow-ups with a source email." : "Checking completed follow-ups…"}</p>}
      </BriefSection>
      <BriefSection title={submitted ? "Search results" : "Recent mail"}>
        <form role="search" className="flex items-center gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (submitted === query.trim()) setAttempt((value) => value + 1);
          else setSubmitted(query.trim());
        }}>
          <Input aria-label="Search mail" placeholder="Search mail" maxLength={512} value={query}
            onChange={(event) => { setQuery(event.target.value); if (!event.target.value.trim()) setSubmitted(""); }} />
          <Button type="submit" disabled={!query.trim()}>Search</Button>
        </form>
        {rows.length ? (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {rows.slice(0, 24).map((row) => (
              <Button key={row.source} type="button" variant="ghost" className="flex min-h-11 w-full justify-start gap-2 rounded-none px-3"
                onClick={() => setTarget({ mailbox: row.mailbox, source: row.source, title: row.subject })}>
                <span className="min-w-0 flex-1 truncate text-left">{row.subject || "(No subject)"}</span>
                <span className="max-w-[35%] truncate text-muted-foreground">{row.sender}</span>
              </Button>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">{recent ? recent.failed ? "Couldn’t load mail." : submitted ? "No matching emails." : "No recent emails found." : "Loading mail…"}</p>}
      </BriefSection>
      {brief?.failed || recent?.failed ? (
        <div role="status" className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Some mailboxes could not be checked.</p>
          <Button type="button" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
        </div>
      ) : null}
      {target ? <MailThreadDialog key={target.source} target={target} onClose={() => setTarget(undefined)}
        onSource={(source) => setTarget({ ...target, source })} /> : null}
    </div>
  );
}

export function PrivateMailTopics({ accounts, session }: { accounts: Mailbox[]; session: TodoWriteParams }) {
  const [batch, setBatch] = useState<ReadBatch<PrivateMailTopic[]>>();
  const [attempt, setAttempt] = useState(0);
  const [target, setTarget] = useState<Target>();
  const { userId, vaultKey, vaultOwnerToken } = session;

  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted;
    const access = { userId, vaultKey, vaultOwnerToken, isCurrent: current, signal: controller.signal };
    setBatch(undefined);
    void readMailboxes(accounts, async (mailbox) => {
      const stored = await PrivateMailStateService.read(access, mailbox, "topics");
      if (stored && !attempt) return privateTopicsSchema.parse(stored.value);
      const brief = await MailFollowupsService.brief(selection(mailbox), controller.signal);
      try {
        await PrivateMailStateService.write(access, mailbox, "topics", brief.topics, stored?.revision ?? 0);
      } catch (error) {
        if ((error as { code?: string }).code !== "stale_version") throw error;
        const latest = await PrivateMailStateService.read(access, mailbox, "topics");
        if (!latest) throw error;
        return privateTopicsSchema.parse(latest.value);
      }
      return brief.topics;
    }, controller.signal)
      .then((value) => { if (current()) setBatch(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [accounts, attempt, userId, vaultKey, vaultOwnerToken]);

  const topics = batch?.values.flatMap(({ mailbox, value }) =>
    value.map((topic) => ({ mailbox, ...topic }))) ?? [];
  if (!accounts.length) return null;
  return (
    <BriefSection title="Private topics">
      {topics.map((topic) => (
        <OverviewCard key={topic.id} title={topic.name} reason={topic.reason}
          mailbox={accounts.length > 1 ? topic.mailbox.email : null} action="View emails"
          onOpen={() => setTarget({ mailbox: topic.mailbox, source: topic.evidence[0]!.source_id, title: topic.name, evidence: topic.evidence })} />
      ))}
      {topics.length === 0 ? <p className="text-sm text-muted-foreground">
        {batch ? batch.failed ? "Couldn’t load topics for every mailbox." : "No recurring topics found in recent mail." : "Checking private topics…"}
      </p> : null}
      {batch ? <Button type="button" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>Refresh topics</Button> : null}
      {target ? <MailThreadDialog key={target.source} target={target} onClose={() => setTarget(undefined)}
        onSource={(source) => setTarget({ ...target, source })} /> : null}
    </BriefSection>
  );
}
