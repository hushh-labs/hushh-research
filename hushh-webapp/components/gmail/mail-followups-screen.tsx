"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { MailActionButton } from "./mail-action-button";
import { MailFollowupsBoard } from "./mail-followups-board";
import {
  type FollowupMailbox,
  type MailFollowup,
  evidenceSchema,
  sourceListSchema,
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
} from "@/lib/vault/session-epoch";

import {
  MAIL_FOLLOWUP_TEMPLATE,
  PodScheduledTasksClient,
  type ScheduledTasksStatus,
} from "@/lib/services/pod-scheduled-tasks";

type Rows = z.infer<typeof sourceListSchema>["items"];
type Evidence = z.infer<typeof evidenceSchema>;

async function recordReply(
  scheduler: PodScheduledTasksClient,
  session: TodoWriteParams,
  task: TodoItem,
  received: NonNullable<MailFollowup["received"]>,
  signal: AbortSignal,
) {
  const id = task.mailFollowup?.scheduleId;
  if (id) {
    const status = await scheduler.status(signal);
    const scheduled = status.tasks.find(
      (row) => row.id === id && row.capability === MAIL_FOLLOWUP_TEMPLATE,
    );
    if (!scheduled)
      throw new Error("Could not verify the scheduled follow-up.");
    if (scheduled.state === "cancelling")
      throw new Error("Mail is waiting for cancellation to finish.");
    if (scheduled.state !== "completed" && scheduled.state !== "cancelled") {
      const updated = await scheduler.control(scheduled, "cancel", signal);
      if (updated.state !== "cancelled")
        throw new Error("Mail is waiting for cancellation to finish.");
    }
  }
  signal.throwIfAborted();
  return tasks.updateMail(session, task, { received });
}

export function MailFollowupsScreen({
  session,
  account,
  connection,
  handoff,
  mail = MailFollowupsService,
  onBack,
}: {
  mail?: typeof MailFollowupsService;
  handoff?: { key: string; action: "evidence" | "plan" };
  session: TodoWriteParams;
  account: string;
  connection: string;
  onBack: () => void;
}) {
  const [view, setView] = useState<
    "board" | "search" | "evidence" | "review" | "plan" | "draft"
  >("board");
  const [activeTask, setActiveTask] = useState<TodoItem>();
  const [downloaded, setDownloaded] = useState(false);
  const [draft, setDraft] = useState<MailFollowup["draft"]>();
  const [notice, setNotice] = useState("");
  const [box, setBox] = useState<FollowupMailbox>();
  const [items, setItems] = useState<TodoItem[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Rows>();
  const [source, setSource] = useState("");
  const [expectation, setExpectation] = useState("");
  const [promise, setPromise] = useState<MailFollowup>();
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
  useEffect(() => {
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setBox(undefined);
    setItems([]);
    setError("");
    Promise.all([
      mail.account(account, connection, controller.signal),
      tasks.load({ userId, vaultOwnerToken, vaultKey }),
    ])
      .then(([mailbox, saved]) => {
        if (!controller.signal.aborted && isVaultSessionEpochCurrent(epoch)) {
          if (mailbox.account !== account || mailbox.connection !== connection)
            throw new Error("Mailbox changed.");
          setBox(mailbox);
          setItems(saved.tasks);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Follow-ups could not load for this connection.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      flight.current?.abort();
    };
  }, [
    userId,
    vaultKey,
    vaultOwnerToken,
    epoch,
    revision,
    account,
    connection,
    mail,
  ]);

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
    if (!box || !handoff || consumed.current) return;
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
  }, [box, handoff, items]);
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
    const item = task.mailFollowup!;
    if (
      !box ||
      item.account !== box.account ||
      item.connection !== box.connection
    )
      throw new Error("Mailbox changed.");
    if (task.status !== "pending") return false;
    const found = await mail.check(box, item, signal);
    if (!found.source) return false;
    signal.throwIfAborted();
    const result = await recordReply(
      scheduler,
      session,
      task,
      { source: found.source, filename: found.filename },
      signal,
    );
    if (!result.success)
      throw new Error("The task changed. Reopen Follow-ups.");
    return true;
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
            : "Watching for the requested reply while this board is open.",
        );
      },
    );
  }
  useEffect(() => {
    if (!box || view !== "board") return;
    const pending = items.filter(
      (row) =>
        row.status === "pending" &&
        row.mailFollowup?.watching &&
        row.mailFollowup.account === box.account &&
        row.mailFollowup.connection === box.connection,
    );
    if (!pending.length) return;
    const controller = new AbortController();
    let running = false;
    async function refreshWatched() {
      if (
        running ||
        document.visibilityState === "hidden" ||
        !isVaultSessionEpochCurrent(epoch)
      )
        return;
      running = true;
      try {
        let changed = false;
        for (const task of pending) {
          const found = await mail.check(
            box!,
            task.mailFollowup!,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          if (found.source && isVaultSessionEpochCurrent(epoch)) {
            const result = await recordReply(
              scheduler,
              { userId, vaultOwnerToken, vaultKey },
              task,
              { source: found.source, filename: found.filename },
              controller.signal,
            );
            changed ||= result.success;
          }
        }
        if (changed) {
          const saved = await tasks.load({ userId, vaultOwnerToken, vaultKey });
          if (!controller.signal.aborted && isVaultSessionEpochCurrent(epoch))
            setItems(saved.tasks);
        }
      } catch {
        if (!controller.signal.aborted)
          setError("Mail could not check the watched replies. It will retry.");
      } finally {
        running = false;
      }
    }
    const timer = window.setInterval(refreshWatched, 60000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    box,
    items,
    view,
    userId,
    vaultOwnerToken,
    vaultKey,
    epoch,
    scheduler,
    mail,
  ]);
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
          setDraft(result.draft);
          setView("draft");
        }
      },
    );
  }
  function back() {
    cancel();
    if (view === "board") onBack();
    else setView("board");
  }
  return (
    <section>
      <MailActionButton onClick={back}>
        {view === "board" ? "Back to Mail" : "Back to Follow-ups"}
      </MailActionButton>
      {box && (
        <p className="my-2 text-sm text-muted-foreground">{box.address}</p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          {!box && (
            <MailActionButton onClick={() => setRevision((n) => n + 1)}>
              Try again
            </MailActionButton>
          )}
        </p>
      )}
      {busy && <p role="status">Checking…</p>}
      {box && view === "board" && (
        <MailFollowupsBoard
          tasks={items}
          mailboxes={[box]}
          onTrack={() => {
            cancel();
            setSource("");
            setExpectation("");
            setQuery("");
            setResults(undefined);
            setPromise(undefined);
            setView("search");
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
      {box && activeTask?.mailFollowup && view === "plan" && (
        <section className="grid gap-3">
          <h2>{activeTask.title}</h2>
          <p>{activeTask.mailFollowup.fulfilment}</p>
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
      {view === "draft" && box && activeTask && draft && (
        <section className="grid gap-3">
          <h2>Review draft</h2>
          <p>From {box.address}</p>
          <p>To {draft.to}</p>
          <label>
            Subject
            <input
              className="block w-full rounded border p-2"
              value={draft.subject}
              maxLength={998}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </label>
          <label>
            Message
            <textarea
              className="block w-full rounded border p-2"
              rows={6}
              maxLength={12000}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          {scheduleMode && (
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
                  !(Date.parse(sendAt) > Date.now())
                }
                onClick={() =>
                  void run(
                    async (signal) => {
                      const due = Math.floor(Date.parse(sendAt) / 1000);
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
                async () => {
                  const result = await tasks.updateMail(session, activeTask, {
                    draft,
                  });
                  if (!result.success)
                    throw new Error("Your draft could not be saved.");
                  return tasks.load(session);
                },
                (saved) => {
                  setItems(saved.tasks);
                  setView("board");
                  setNotice("Draft saved for review.");
                },
              )
            }
          >
            Save for review
          </MailActionButton>
        </section>
      )}
      {box && view === "search" && (
        <div className="grid gap-4">
          <h2>Track a conversation</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSource("");
              setResults(undefined);
              void run(
                (signal) => mail.search(box, query.trim(), signal),
                (result) => setResults(result.items),
              );
            }}
          >
            <label className="grid gap-1">
              Person or topic
              <input
                className="rounded-lg border p-2"
                maxLength={512}
                required
                value={query}
                onChange={(e) => {
                  cancel();
                  setQuery(e.target.value);
                  setResults(undefined);
                  setSource("");
                }}
              />
            </label>
            <MailActionButton type="submit" disabled={!query.trim() || busy}>
              Find conversation
            </MailActionButton>
          </form>
          {results && !results.length && <p>No emails matched this search.</p>}
          {results?.map((row) => (
            <label key={row.source} className="flex items-center gap-2">
              <input
                type="radio"
                name="mail-source"
                checked={source === row.source}
                onChange={() => {
                  cancel();
                  setSource(row.source);
                }}
              />
              <span>
                {row.subject} · {row.sender}
              </span>
            </label>
          ))}
          {source && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  (signal) =>
                    mail.track(
                      box,
                      source,
                      expectation.trim(),
                      signal,
                      items.flatMap((task) => {
                        const prior = task.mailFollowup;
                        return prior?.source === source &&
                          prior.connection === box.connection
                          ? [prior.quote]
                          : [];
                      }),
                    ),
                  (finding) => {
                    if (
                      finding.account === box.account &&
                      finding.connection === box.connection &&
                      finding.source === source
                    ) {
                      setPromise(finding);
                      setView("review");
                    } else setError("The mailbox changed. Search again.");
                  },
                );
              }}
            >
              <label className="grid gap-1">
                What are you waiting for?
                <textarea
                  className="rounded-lg border p-2"
                  required
                  maxLength={500}
                  value={expectation}
                  onChange={(e) => {
                    cancel();
                    setExpectation(e.target.value);
                  }}
                />
              </label>
              <MailActionButton
                type="submit"
                disabled={!expectation.trim() || busy}
              >
                Check with Mail AI
              </MailActionButton>
            </form>
          )}
        </div>
      )}
      {view === "review" && promise && (
        <section>
          <h2>{promise.title}</h2>
          <p>
            Waiting on{" "}
            {promise.waiting_on === "owner" ? "you" : promise.participant}
          </p>
          <p>{promise.fulfilment}</p>
          {promise.promised_wording && (
            <p>
              Promised {promise.promised_wording}
              {promise.due_date && (
                <>
                  {" "}
                  · Task due {promise.due_date}
                  {promise.due_time && " at " + promise.due_time}
                </>
              )}
            </p>
          )}
          <blockquote className="my-2 border-l-2 pl-3">
            {promise.quote}
          </blockquote>
          <MailActionButton
            disabled={busy}
            onClick={() =>
              void run(
                async (signal) => {
                  const result = await tasks.trackMail(session, promise);
                  if (!result.success)
                    throw new Error("The shared task could not be saved.");
                  signal.throwIfAborted();
                  return tasks.load(session);
                },
                (saved) => {
                  setItems(saved.tasks);
                  setView("board");
                },
              )
            }
          >
            Track in Tasks
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
