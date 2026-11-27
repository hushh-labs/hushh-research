"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Mail, Search as SearchIcon } from "@/components/icons";
import {
  type FollowupMailbox,
  type MailFollowup,
  sourceListSchema,
} from "@/lib/mail/mail-followup-model";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import {
  TodoListPkmService as tasks,
  type TodoItem,
  type TodoListState,
  type TodoWriteParams,
} from "@/lib/services/todo-list-pkm-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import styles from "./mail-track-dialog.module.css";
import mailStyles from "./mail-workspace.module.css";

type Rows = z.infer<typeof sourceListSchema>["items"];
type Row = Rows[number];

/** Typing waits this long for a pause before it asks the mailbox. */
export const TRACK_SEARCH_DELAY_MS = 250;

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Track a conversation: pick one email from this mailbox, say what is expected,
 * check it, then confirm. Opening the dialog and searching only read mail; the one
 * shared Task is created or reused at the final confirmation, linked to the exact
 * source. The list belongs to the query that asked for it, so a late answer for an
 * earlier query is never shown.
 */
export function MailTrackDialog({
  open,
  onClose,
  mail = MailFollowupsService,
  box,
  session,
  existing,
  onTracked,
}: {
  open: boolean;
  onClose: () => void;
  mail?: typeof MailFollowupsService;
  box: FollowupMailbox;
  session: TodoWriteParams;
  existing: readonly TodoItem[];
  onTracked: (saved: TodoListState) => void;
}) {
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<{ key: string; rows: Rows }>();
  const [listFailed, setListFailed] = useState(false);
  const [picked, setPicked] = useState<Row>();
  const [expectation, setExpectation] = useState("");
  const [promise, setPromise] = useState<MailFollowup>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef<AbortController | null>(null);
  const epoch = useRef(snapshotVaultSessionEpoch());
  const { account, connection } = box;

  // The mailbox, the query and a retry together name one read. Anything else is stale.
  const key = JSON.stringify([account, connection, applied, attempt]);

  // A dialog that closes forgets everything; reopening starts from recent conversations.
  useEffect(() => {
    if (open) {
      epoch.current = snapshotVaultSessionEpoch();
      return;
    }
    flight.current?.abort();
    setQuery("");
    setApplied("");
    setAttempt(0);
    setList(undefined);
    setListFailed(false);
    setPicked(undefined);
    setExpectation("");
    setPromise(undefined);
    setBusy(false);
    setError("");
  }, [open]);

  // Typing settles into one query after a pause; clearing it is immediate and restores recent mail.
  useEffect(() => {
    const next = query.trim();
    if (next === applied) return;
    if (!next) {
      setApplied("");
      return;
    }
    const timer = window.setTimeout(() => setApplied(next), TRACK_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, applied]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setListFailed(false);
    const read = applied ? mail.search(box, applied, controller.signal) : mail.recent(box, controller.signal);
    read
      .then((result) => {
        if (!controller.signal.aborted && isVaultSessionEpochCurrent(epoch.current)) setList({ key, rows: result.items });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !aborted(failure)) setListFailed(true);
      });
    return () => controller.abort();
    // `key` already names the mailbox, the query and the retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, mail]);

  const rows = list?.key === key ? list.rows : undefined;
  const priorQuotes = useMemo(
    () =>
      picked
        ? existing.flatMap((task) =>
            task.mailFollowup?.source === picked.source && task.mailFollowup.connection === connection
              ? [task.mailFollowup.quote]
              : [],
          )
        : [],
    [existing, picked, connection],
  );

  async function run<T>(read: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void) {
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setError("");
    try {
      const value = await read(controller.signal);
      if (!controller.signal.aborted && isVaultSessionEpochCurrent(epoch.current)) accept(value);
    } catch (failure) {
      if (!controller.signal.aborted && !aborted(failure))
        setError(failure instanceof Error ? failure.message : "Mail could not complete this request.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const step = promise ? "review" : picked ? "expect" : "pick";

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Track a conversation"
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[560px]"
      surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
      bodyClassName={styles.body}
    >
      <div className={styles.mailbox} data-testid="track-mailbox">
        <Mail aria-hidden="true" className="size-4 shrink-0" />
        <span className={styles.mailboxAddress}>{box.address}</span>
      </div>

      {step === "pick" ? (
        <>
          <label className={styles.search}>
            <SearchIcon aria-hidden="true" className="size-5 shrink-0" />
            <span className="sr-only">Person or topic</span>
            <input
              className={styles.searchInput}
              type="search"
              placeholder="Person or topic"
              maxLength={512}
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className={styles.list} data-testid="track-list">
            {listFailed ? (
              <div className={styles.state} role="alert">
                <p>Couldn’t load this mailbox. Try again.</p>
                <button type="button" className={styles.link} onClick={() => setAttempt((value) => value + 1)}>
                  Try again
                </button>
              </div>
            ) : !rows ? (
              <p className={styles.state} role="status">
                {applied || query.trim() ? "Searching…" : "Loading recent conversations…"}
              </p>
            ) : rows.length === 0 ? (
              <p className={styles.state} role="status">
                {applied ? "No emails matched this search." : "No recent conversations in this mailbox."}
              </p>
            ) : (
              <ul className={styles.rows}>
                {rows.map((row) => (
                  <li key={row.source}>
                    <button
                      type="button"
                      className={styles.row}
                      onClick={() => {
                        flight.current?.abort();
                        setPicked(row);
                        setExpectation("");
                        setError("");
                      }}
                    >
                      <span className={styles.subject}>{row.subject || "(No subject)"}</span>
                      <span className={styles.sender}>{row.sender}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}

      {step === "expect" && picked ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              (signal) => mail.track(box, picked.source, expectation.trim(), signal, priorQuotes),
              (finding) => {
                if (finding.account === account && finding.connection === connection && finding.source === picked.source) setPromise(finding);
                else setError("The mailbox changed. Search again.");
              },
            );
          }}
        >
          <div className={styles.chosen}>
            <span className={styles.subject}>{picked.subject || "(No subject)"}</span>
            <span className={styles.sender}>{picked.sender}</span>
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>What are you waiting for?</span>
            <textarea
              className={styles.textarea}
              required
              maxLength={500}
              rows={3}
              value={expectation}
              onChange={(event) => setExpectation(event.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => setPicked(undefined)}>
              Choose another
            </button>
            <button type="submit" className={styles.primary} disabled={!expectation.trim() || busy}>
              {busy ? "Checking…" : "Check with Mail AI"}
            </button>
          </div>
        </form>
      ) : null}

      {step === "review" && promise ? (
        <div className={styles.form}>
          <h3 className={styles.reviewTitle}>{promise.title}</h3>
          <p className={styles.sender}>Waiting on {promise.waiting_on === "owner" ? "you" : promise.participant}</p>
          <p>{promise.fulfilment}</p>
          {promise.promised_wording ? (
            <p className={styles.sender}>
              Promised {promise.promised_wording}
              {promise.due_date ? ` · Task due ${promise.due_date}${promise.due_time ? ` at ${promise.due_time}` : ""}` : ""}
            </p>
          ) : null}
          <blockquote className={styles.quote}>{promise.quote}</blockquote>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => setPromise(undefined)}>
              Back
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() =>
                void run(
                  async (signal) => {
                    const result = await tasks.trackMail(session, promise);
                    if (!result.success) throw new Error("The shared task could not be saved.");
                    signal.throwIfAborted();
                    return tasks.load(session);
                  },
                  (saved) => {
                    onTracked(saved);
                    onClose();
                  },
                )
              }
            >
              {busy ? "Saving…" : "Track in Tasks"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </AdaptiveDetailSurface>
  );
}
