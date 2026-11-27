"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { z } from "zod";
import { MailActionButton } from "./mail-action-button";
import { MailTaskReminder } from "./mail-task-reminder";
import { MailTrackDialog } from "./mail-track-dialog";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { CacheService } from "@/lib/services/cache-service";
import { MailFollowupsBoard } from "./mail-followups-board";
import { checkMailFollowup, useSettledMailTasks } from "./mail-followups-session-watch";
import {
  type FollowupMailbox,
  type MailFollowup,
  evidenceSchema,
} from "@/lib/mail/mail-followup-model";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import {
  TodoListPkmService as tasks,
  type TodoItem,
  type TodoWriteParams,
} from "@/lib/services/todo-list-pkm-service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

import {
  MAIL_FOLLOWUP_TEMPLATE,
  PodScheduledTasksClient,
  type ScheduledTasksStatus,
} from "@/lib/services/pod-scheduled-tasks";

type Evidence = z.infer<typeof evidenceSchema>;

/** A draft the Overview asked for on one email. It becomes a Task only when the owner saves it. */
export type MailDraftRequest = { id: string; sourceId: string; title: string; expectation: string };

const EDIT_PREFIX = "mail_followup_draft_edit:";
subscribeVaultSessionEpoch(() => CacheService.getInstance().invalidatePattern(EDIT_PREFIX));

export function MailFollowupsScreen({
  session,
  account,
  connection,
  verifiedAddress,
  savedTasks,
  handoff,
  draftRequest,
  mail = MailFollowupsService,
}: {
  mail?: typeof MailFollowupsService;
  handoff?: { key: string; action: "evidence" | "plan" };
  /** One draft the Overview asked for; it is consumed once. */
  draftRequest?: MailDraftRequest;
  session: TodoWriteParams;
  account: string;
  connection: string;
  verifiedAddress?: string;
  savedTasks?: ReturnType<typeof tasks.load>;
}) {
  const [view, setView] = useState<"board" | "evidence" | "plan" | "draft">("board");
  const [trackOpen, setTrackOpen] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<Omit<MailDraftRequest, "id">>();
  const [activeTask, setActiveTask] = useState<TodoItem>();
  const [downloaded, setDownloaded] = useState(false);
  const [draft, setDraft] = useState<MailFollowup["draft"]>();
  const [notice, setNotice] = useState("");
  const [box, setBox] = useState<FollowupMailbox>();
  const [items, setItems] = useState<TodoItem[]>([]);
  const [tasksReady, setTasksReady] = useState(false);
  const [evidence, setEvidence] = useState<Evidence>();
  const scheduler = useMemo(
    () => new PodScheduledTasksClient(session.userId),
    [session.userId],
  );
  const [schedules, setSchedules] = useState<ScheduledTasksStatus>();
  const [scheduleMode, setScheduleMode] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const scheduled = schedules?.tasks.find(
    (task) => task.id === activeTask?.mailFollowup?.scheduleId,
  );
  useEffect(() => {
    if (view !== "plan" || !box) return;
    const controller = new AbortController();
    setSchedules(undefined);
    scheduler
      .status(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setSchedules(status);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [view, box, scheduler]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const flight = useRef<AbortController | null>(null);
  const { userId, vaultKey, vaultOwnerToken } = session;
  const epoch = snapshotVaultSessionEpoch();
  function cancel() {
    flight.current?.abort();
    setBusy(false);
    setError("");
  }
  // The mailbox is resolved once per mailbox. A Task write replaces `savedTasks` and must not
  // reset this screen or cancel the operation that caused it, so Tasks refresh in their own effect.
  useEffect(() => {
    const controller = new AbortController();
    setBox(undefined);
    setError("");
    Promise.resolve(
      verifiedAddress
        ? { account, connection, address: verifiedAddress }
        : mail.account(account, connection, controller.signal),
    )
      .then((mailbox) => {
        if (controller.signal.aborted || !isVaultSessionEpochCurrent(epoch)) return;
        if (mailbox.account !== account || mailbox.connection !== connection)
          throw new Error("Mailbox changed.");
        setBox(mailbox);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Follow-ups could not load for this connection.");
      });
    return () => controller.abort();
  }, [epoch, revision, account, connection, verifiedAddress, mail]);
  useEffect(() => {
    const controller = new AbortController();
    (savedTasks ?? tasks.load({ userId, vaultOwnerToken, vaultKey }))
      .then((saved) => {
        if (controller.signal.aborted || !isVaultSessionEpochCurrent(epoch)) return;
        setItems(saved.tasks);
        setTasksReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Follow-ups could not load for this connection.");
      });
    return () => controller.abort();
  }, [userId, vaultKey, vaultOwnerToken, epoch, revision, savedTasks]);

  async function run<T>(
    read: (signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void,
  ) {
    cancel();
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    try {
      const value = await read(controller.signal);
      if (!controller.signal.aborted && isVaultSessionEpochCurrent(epoch))
        accept(value);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Mail could not complete this request.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function openEvidence(item: MailFollowup) {
    if (
      !box ||
      item.account !== box.account ||
      item.connection !== box.connection
    )
      return;
    setView("evidence");
    setEvidence(undefined);
    void run((signal) => mail.open(box, item.source, signal), setEvidence);
  }
  const openHandoff = useEffectEvent(
    (task: TodoItem, action: "plan" | "evidence") => {
      if (action === "evidence") openEvidence(task.mailFollowup!);
      else plan(task);
    },
  );
  const consumed = useRef(false);
  useEffect(() => {
    if (!box || !tasksReady || !handoff || consumed.current) return;
    consumed.current = true;
    const task = items.find(
      (row) =>
        row.mailFollowup?.key === handoff.key &&
        row.mailFollowup.connection === box.connection,
    );
    if (!task) {
      setError("The selected task changed. Choose it again.");
      return;
    }
    openHandoff(task, handoff.action);
  }, [box, tasksReady, handoff, items]);
  function plan(task: TodoItem) {
    cancel();
    setScheduleMode(false);
    setSendAt("");
    setDownloaded(false);
    setActiveTask(task);
    setNotice("");
    setDraft(task.mailFollowup?.draft);
    setView("plan");
  }
  async function check(task: TodoItem, signal: AbortSignal) {
    if (!box) throw new Error("Mailbox changed.");
    return checkMailFollowup(session, task, box, scheduler, signal, mail);
  }
  function changeReminder(task: TodoItem, dueAt?: string) {
    if (!box || task.mailFollowup?.account !== box.account ||
        task.mailFollowup.connection !== box.connection) return;
    void run(async (signal) => {
      const current = () => !signal.aborted && isVaultSessionEpochCurrent(epoch);
      const result = dueAt
        ? await tasks.setPersonalReminder(session, task, dueAt, current)
        : await tasks.cancelPersonalReminder(session, task, current);
      if (!result.success) throw new Error("The reminder could not be updated. Try again.");
      return tasks.load(session);
    }, (saved) => {
      setItems(saved.tasks);
      setActiveTask(saved.tasks.find((row) => row.id === task.id));
    });
  }
  function watch(task: TodoItem) {
    void run(
      async (signal) => {
        const done = await check(task, signal);
        if (!done && !task.mailFollowup?.watching) {
          signal.throwIfAborted();
          const result = await tasks.updateMail(session, task, {
            watching: true,
          });
          if (!result.success)
            throw new Error("Mail could not save this watch.");
        }
        return { done, saved: await tasks.load(session) };
      },
      ({ done, saved }) => {
        setItems(saved.tasks);
        setView("board");
        setNotice(
          done
            ? "The matching reply arrived. Task completed."
            : "Watching for the requested reply while One is open and your vault is unlocked.",
        );
      },
    );
  }
  useSettledMailTasks(session, (rows) => {
    setItems(rows);
    setActiveTask((previous) => previous && rows.find((row) => row.id === previous.id));
  });
  function editKey(task: TodoItem, to: string) {
    return EDIT_PREFIX + JSON.stringify([epoch, userId, account, connection, task.id, task.revision, to]);
  }

  function editDraft(next: NonNullable<MailFollowup["draft"]>) {
    if (!isVaultSessionEpochCurrent(epoch)) return;
    // A draft with no Task yet is held only in this view; it is stored once it is saved.
    if (activeTask) CacheService.getInstance().set(editKey(activeTask, next.to), { subject: next.subject, body: next.body });
    setDraft(next);
  }

  function prepare(task: TodoItem) {
    const item = task.mailFollowup!;
    if (!box) return;
    void run(
      async (signal) => {
        if (await check(task, signal))
          return { saved: await tasks.load(session) };
        const next = item.received;
        if (next?.filename && !item.reviewed)
          throw new Error("Review the received document first.");
        return {
          draft:
            item.draft ??
            (await mail.draft(
              box,
              next?.source ?? item.source,
              next
                ? "Prepare a reply after my review of the received document."
                : "Ask for this outstanding item: " + item.fulfilment,
              signal,
            )),
        };
      },
      (result) => {
        if (result.saved) {
          setItems(result.saved.tasks);
          setView("board");
          setNotice("The requested reply arrived.");
        } else {
          const edits = CacheService.getInstance().peek<Pick<NonNullable<MailFollowup["draft"]>, "subject" | "body">>(
            editKey(task, result.draft.to),
          )?.data;
          setDraft({ ...result.draft, ...edits });
          setView("draft");
        }
      },
    );
  }
  // The app's own Back returns from a detail to the board before it leaves Mail; the board has no Back of its own.
  const pathname = usePathname();
  useBackLayer(normalizeStaticExportPathname(pathname), view === "board" ? 0 : 1, () => {
    cancel();
    setPendingDraft(undefined);
    setView("board");
    return true;
  });

  // A draft the Overview asked for opens for review here. It creates nothing until it is saved.
  const draftConsumed = useRef<string>("");
  useEffect(() => {
    if (!box || !draftRequest || draftConsumed.current === draftRequest.id) return;
    draftConsumed.current = draftRequest.id;
    cancel();
    setActiveTask(undefined);
    setScheduleMode(false);
    setSendAt("");
    setNotice("");
    setPendingDraft({ sourceId: draftRequest.sourceId, title: draftRequest.title, expectation: draftRequest.expectation });
    void run(
      (signal) => mail.draft(box, draftRequest.sourceId, draftRequest.expectation, signal),
      (prepared) => {
        setDraft(prepared);
        setView("draft");
      },
    );
    // `run` and `cancel` are recreated on every render; the request id is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, draftRequest]);

  return (
    <section>
      {view !== "board" && (
        <MailActionButton
          onClick={() => {
            cancel();
            setPendingDraft(undefined);
            setView("board");
          }}
        >
          Back to Follow-ups
        </MailActionButton>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          {!(box && tasksReady) && (
            <MailActionButton onClick={() => { setTasksReady(false); setRevision((n) => n + 1); }}>
              Try again
            </MailActionButton>
          )}
        </p>
      )}
      {(busy || (!error && !(box && tasksReady))) && <p role="status">Checking…</p>}
      {box && tasksReady && view === "board" && (
        <MailFollowupsBoard
          tasks={items}
          mailboxes={[box]}
          onTrack={() => {
            cancel();
            setTrackOpen(true);
          }}
          onEvidence={openEvidence}
          onAction={plan}
          onDraft={(task) => {
            plan(task);
            prepare(task);
          }}
        />
      )}
      {notice && view === "board" && <p role="status">{notice}</p>}
      {box && (
        <MailTrackDialog
          open={trackOpen}
          onClose={() => setTrackOpen(false)}
          mail={mail}
          box={box}
          session={session}
          existing={items}
          onTracked={(saved) => setItems(saved.tasks)}
        />
      )}
      {box && activeTask?.mailFollowup && view === "plan" && (
        <section className="grid gap-3">
          <h2>{activeTask.title}</h2>
          <p>{activeTask.mailFollowup.fulfilment}</p>
          <MailTaskReminder
            key={[activeTask.id, activeTask.personalReminder?.id, activeTask.personalReminder?.dueAt, activeTask.personalReminder?.state].join("/")}
            task={activeTask}
            busy={busy}
            onSave={(dueAt) => changeReminder(activeTask, dueAt)}
            onCancel={() => changeReminder(activeTask)}
          />
          {activeTask.status === "pending" && (
            <MailActionButton disabled={busy} onClick={() => watch(activeTask)}>
              Watch for a reply
            </MailActionButton>
          )}
          {activeTask.mailFollowup.received && (
            <MailActionButton
              onClick={() => {
                const item = activeTask.mailFollowup!;
                openEvidence({ ...item, source: item.received!.source });
              }}
            >
              View received email
            </MailActionButton>
          )}
          {activeTask.mailFollowup.received?.filename &&
            !activeTask.mailFollowup.reviewed && (
              <>
                <MailActionButton
                  disabled={busy}
                  onClick={() => {
                    const { source, filename } =
                      activeTask.mailFollowup!.received!;
                    void run(
                      (signal) => mail.document(box, source, filename!, signal),
                      ({ content }) => {
                        const bytes = Uint8Array.from(atob(content), (c) =>
                          c.charCodeAt(0),
                        );
                        const url = URL.createObjectURL(
                          new Blob([bytes], {
                            type: "application/octet-stream",
                          }),
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = filename!;
                        link.click();
                        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                        setDownloaded(true);
                      },
                    );
                  }}
                >
                  Open {activeTask.mailFollowup.received.filename}
                </MailActionButton>
                <MailActionButton
                  disabled={busy || !downloaded}
                  onClick={() =>
                    void run(
                      async () => {
                        const result = await tasks.updateMail(
                          session,
                          activeTask,
                          { reviewed: true },
                        );
                        if (!result.success)
                          throw new Error("Review could not be saved.");
                        return tasks.load(session);
                      },
                      (saved) => {
                        setItems(saved.tasks);
                        setActiveTask(
                          saved.tasks.find((t) => t.id === activeTask.id),
                        );
                      },
                    )
                  }
                >
                  I reviewed the document
                </MailActionButton>
              </>
            )}
          <MailActionButton
            disabled={
              busy ||
              Boolean(
                activeTask.mailFollowup.received?.filename &&
                !activeTask.mailFollowup.reviewed,
              )
            }
            onClick={() => prepare(activeTask)}
          >
            Prepare for my review
          </MailActionButton>
          {activeTask.status === "pending" &&
            !activeTask.mailFollowup.scheduleId && (
              <>
                <MailActionButton
                  disabled={
                    busy ||
                    !schedules?.available ||
                    !schedules.templates.includes(MAIL_FOLLOWUP_TEMPLATE)
                  }
                  onClick={() => {
                    setScheduleMode(true);
                    prepare(activeTask);
                  }}
                >
                  Send one approved follow-up
                </MailActionButton>
                {(!schedules?.available ||
                  !schedules.templates.includes(MAIL_FOLLOWUP_TEMPLATE)) && (
                  <p>Scheduled sending is unavailable for this connection.</p>
                )}
              </>
            )}
          {activeTask.mailFollowup.scheduleId && (
            <p>
              Scheduled follow-up ·{" "}
              {scheduled?.state.replaceAll("_", " ") || "status unavailable"}
            </p>
          )}
          {scheduled?.last_run?.sent_source && (
            <MailActionButton
              onClick={() =>
                openEvidence({
                  ...activeTask.mailFollowup!,
                  source: scheduled.last_run!.sent_source!,
                })
              }
            >
              View sent email
            </MailActionButton>
          )}
        </section>
      )}
      {view === "draft" && box && (activeTask || pendingDraft) && draft && (
        <section className="grid gap-3">
          <h2>Review draft</h2>
          {!activeTask && pendingDraft && (
            <p className="text-sm text-muted-foreground">
              {pendingDraft.title}. Saving creates one Task linked to this email.
            </p>
          )}
          <p>From {box.address}</p>
          <p>To {draft.to}</p>
          <label>
            Subject
            <input
              className="block w-full rounded border p-2"
              value={draft.subject}
              maxLength={998}
              onChange={(e) => editDraft({ ...draft, subject: e.target.value })}
            />
          </label>
          <label>
            Message
            <textarea
              className="block w-full rounded border p-2"
              rows={6}
              maxLength={12000}
              value={draft.body}
              onChange={(e) => editDraft({ ...draft, body: e.target.value })}
            />
          </label>
          {scheduleMode && activeTask && (
            <>
              <label>
                Send at ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                <input
                  type="datetime-local"
                  className="block rounded border p-2"
                  value={sendAt}
                  onChange={(event) => setSendAt(event.target.value)}
                />
              </label>
              <MailActionButton
                disabled={
                  busy ||
                  !draft.body.trim() ||
                  activeTask.status !== "pending" ||
                  !(Date.parse(sendAt) > Date.now())
                }
                onClick={() =>
                  void run(
                    async (signal) => {
                      const due = Math.floor(Date.parse(sendAt) / 1000);
                      const current = (await tasks.load(session)).tasks.find(row => row.id === activeTask.id);
                      signal.throwIfAborted();
                      if (!current || current.status !== "pending" || current.revision !== activeTask.revision)
                        throw new Error("The task changed. Reopen Follow-ups.");
                      const schedule = await scheduler.sendMailFollowup(
                        box,
                        activeTask.mailFollowup!,
                        draft,
                        due,
                        signal,
                      );
                      const result = await tasks.updateMail(
                        session,
                        activeTask,
                        { scheduleId: schedule.id, watching: true },
                      );
                      if (!result.success)
                        throw new Error(
                          "Schedule accepted. Check Scheduled Tasks before retrying.",
                        );
                      return tasks.load(session);
                    },
                    (saved) => {
                      setItems(saved.tasks);
                      setView("board");
                      setNotice("Approved follow-up scheduled.");
                    },
                  )
                }
              >
                Approve this message and send time
              </MailActionButton>
            </>
          )}
          <MailActionButton
            disabled={busy || !draft.body.trim()}
            onClick={() =>
              void run(
                async (signal) => {
                  let task = activeTask;
                  if (!task && pendingDraft) {
                    // Saving is the confirmation: it creates or reuses the one Task for this exact email.
                    const found = await mail.track(
                      box,
                      pendingDraft.sourceId,
                      pendingDraft.expectation,
                      signal,
                      items.flatMap((row) =>
                        row.mailFollowup?.source === pendingDraft.sourceId && row.mailFollowup.connection === box.connection
                          ? [row.mailFollowup.quote]
                          : [],
                      ),
                    );
                    if (found.account !== box.account || found.connection !== box.connection || found.source !== pendingDraft.sourceId)
                      throw new Error("The mailbox changed. Open the email again.");
                    const tracked = await tasks.trackMail(session, found);
                    if (!tracked.success) throw new Error("The shared task could not be saved.");
                    signal.throwIfAborted();
                    task = (await tasks.load(session)).tasks.find((row) => row.id === found.key);
                  }
                  if (!task) throw new Error("Your draft could not be saved.");
                  const result = await tasks.updateMail(session, task, { draft });
                  if (!result.success)
                    throw new Error("Your draft could not be saved.");
                  return tasks.load(session);
                },
                (saved) => {
                  setItems(saved.tasks);
                  setPendingDraft(undefined);
                  setView("board");
                  if (activeTask) CacheService.getInstance().invalidate(editKey(activeTask, draft.to));
                  setNotice("Draft saved for review.");
                },
              )
            }
          >
            Save for review
          </MailActionButton>
        </section>
      )}
      {view === "evidence" && evidence && (
        <article>
          <h2>{evidence.subject}</h2>
          <p>{evidence.sender}</p>
          <p className="mt-3 whitespace-pre-wrap break-words">
            {evidence.body}
          </p>
          {evidence.body_truncated && <p>Showing part of this email.</p>}
        </article>
      )}
    </section>
  );
}
