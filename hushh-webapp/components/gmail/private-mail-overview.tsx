"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Search as SearchIcon } from "@/components/icons";
import { MailOverviewError, type OpenedOverviewMessage } from "@/lib/mail/mail-overview-client";
import type { CompletedItem, MailBrief, MailCompleted } from "@/lib/mail/mail-brief-client";
import { privateCompletedItems } from "@/lib/mail/private-mail-completed";
import type { BriefPart } from "@/lib/mail/use-mail-brief";
import { usePrivateMailSession } from "@/lib/mail/private-mail-session";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import { areScheduledTasksAvailable, PodScheduledTasksClient, type ScheduledTask } from "@/lib/services/pod-scheduled-tasks";
import type { PrivateMailAccount } from "@/lib/services/private-google-connections";
import type { TodoListState } from "@/lib/services/todo-list-pkm-service";
import type { DraftRequest } from "./mail-brief";
import { MailBriefPanel } from "./mail-brief-panel";
import { MailWhySheet, type WhyTarget } from "./mail-brief-why";
import styles from "./mail-brief.module.css";

/** What a draft needs: the message it is written on, and what the owner is asking for. */
export type PrivateDraftRequest = { sourceId: string; title: string; expectation: string };

type Rows = Awaited<ReturnType<typeof MailFollowupsService.recent>>["items"];
type Mailbox = { account: string; connection: string; address: string };

const noDate = "";
const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

function briefPart(session: NonNullable<ReturnType<typeof usePrivateMailSession>>): BriefPart<MailBrief> {
  const data = session.brief ?? null;
  return {
    status: data ? "ready" : session.briefError ? "error" : "loading",
    data,
    error: session.briefError ? new MailOverviewError("retryable") : null,
    refreshing: Boolean(data && session.briefUpdating),
    fetchedAt: data ? Date.parse(data.generatedAt) || 0 : 0,
  };
}

/** What One settled for this mailbox: its Tasks and the follow-ups it sent on a schedule. */
function useCompleted(
  mailbox: Mailbox,
  userId: string | undefined,
  savedTasks: Promise<TodoListState> | undefined,
  revision: number,
): BriefPart<MailCompleted> {
  const [part, setPart] = useState<BriefPart<MailCompleted>>({ status: "loading", data: null, error: null, refreshing: false, fetchedAt: 0 });
  const { account, connection } = mailbox;
  useEffect(() => {
    if (!savedTasks) {
      setPart((old) => ({ ...old, status: old.data ? "ready" : "loading" }));
      return;
    }
    const controller = new AbortController();
    setPart((old) => ({ ...old, status: old.data ? "ready" : "loading", refreshing: Boolean(old.data), error: null }));
    void (async () => {
      const saved = await savedTasks;
      let schedules: ScheduledTask[] | undefined;
      if (userId && areScheduledTasksAvailable() && saved.tasks.some((task) => task.mailFollowup?.scheduleId)) {
        // A scheduler that cannot answer only means no sent follow-up is listed; settled Tasks still are.
        schedules = (await new PodScheduledTasksClient(userId).status(controller.signal).catch(() => undefined))?.tasks;
      }
      if (controller.signal.aborted) return;
      setPart({
        status: "ready",
        data: { account, items: privateCompletedItems(saved.tasks, { account, connection }, schedules) },
        error: null,
        refreshing: false,
        fetchedAt: Date.now(),
      });
    })().catch(() => {
      if (!controller.signal.aborted)
        setPart((old) => ({ ...old, status: "error", error: new MailOverviewError("retryable"), refreshing: false }));
    });
    return () => controller.abort();
  }, [account, connection, userId, savedTasks, revision]);
  return part;
}

/**
 * Search and recent mail for one private mailbox. Reading happens on the owner's
 * private runtime; a row opens that exact message and nothing else.
 */
function PrivateMailTools({ mailbox, onOpen }: { mailbox: Mailbox; onOpen: (row: Rows[number]) => void }) {
  const mailSession = usePrivateMailSession();
  const remember = mailSession?.rememberRecent;
  const recentScope = mailSession?.recentScope;
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [rows, setRows] = useState<{ key: string; items: Rows }>();
  const [failed, setFailed] = useState(false);
  const { account, connection, address } = mailbox;
  const key = JSON.stringify([account, connection, submitted]);
  useEffect(() => {
    const controller = new AbortController();
    const box = { account, connection, address };
    setFailed(false);
    const read = submitted
      ? MailFollowupsService.search(box, submitted, controller.signal)
      : MailFollowupsService.recent(box, controller.signal);
    read
      .then((result) => {
        if (controller.signal.aborted) return;
        setRows({ key, items: result.items });
        if (!submitted && recentScope) remember?.(recentScope, result.items);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !aborted(error)) setFailed(true);
      });
    return () => controller.abort();
  }, [account, connection, address, submitted, key, attempt, remember, recentScope]);
  const current = rows?.key === key ? rows.items : !submitted ? mailSession?.recentRows : undefined;
  return (
    <div className={styles.toolsPanel} id="mail-tools-panel" data-testid="private-mail-tools">
      <form
        className={styles.searchRow}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <input
          className={styles.searchInput}
          aria-label="Search mail"
          placeholder="Search this mailbox"
          maxLength={512}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value.trim()) setSubmitted("");
          }}
        />
        <button type="submit" className={styles.pill} disabled={!query.trim()}>
          Search
        </button>
      </form>
      <h3 className={styles.listTitle}>{submitted ? "Search results" : "Recent mail"}</h3>
      {failed && current ? <p className={styles.whyFrom} role="status">Showing the last mail loaded.</p> : null}
      {failed && !current ? (
        <div className={styles.state} role="alert">
          <p>Mail is temporarily unavailable.</p>
          <button type="button" className={styles.link} onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : !current ? (
        <p className={styles.state} role="status">Checking mail…</p>
      ) : current.length === 0 ? (
        <div className={styles.state} role="status">
          <p>{submitted ? "No matching emails." : "No mail found."}</p>
        </div>
      ) : (
        <ul className={styles.panel} data-testid="private-mail-rows">
          {current.map((row) => (
            <li key={row.source} className={styles.mailRow}>
              <button type="button" className={styles.mailRowButton} onClick={() => onOpen(row)}>
                <span className={styles.mailRowSubject}>{row.subject || "(No subject)"}</span>
                <span className={styles.mailRowSender}>{row.sender}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The private mailbox's Overview: the same Needs your attention, Recent updates and
 * Recently completed sections as every Mail Overview, filled from this one mailbox
 * on the owner's private runtime. A section that cannot be filled says why; none is
 * shown as empty when it merely failed.
 */
export function PrivateMailOverview({
  mailbox,
  userId,
  savedTasks,
  onDraft,
  onOpenFollowups,
  onOpenReceipt,
  onReconnect,
  onUnlock,
}: {
  mailbox: PrivateMailAccount;
  userId?: string;
  savedTasks?: Promise<TodoListState>;
  onDraft: (request: PrivateDraftRequest) => void;
  onOpenFollowups: () => void;
  onOpenReceipt: (findingId: string) => void;
  onReconnect: () => void;
  onUnlock: () => void;
}) {
  const session = usePrivateMailSession();
  const box = useMemo<Mailbox>(
    () => ({ account: mailbox.accountId, connection: mailbox.credentialId, address: mailbox.email ?? "" }),
    [mailbox.accountId, mailbox.credentialId, mailbox.email],
  );
  const [revision, setRevision] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [why, setWhy] = useState<WhyTarget | null>(null);
  const completed = useCompleted(box, userId, savedTasks, revision);
  const brief = useMemo(() => (session ? briefPart(session) : null), [session]);
  const retry = session?.retryBrief;

  // One mailbox, one reader: a message opens through the owner's private runtime and only for this mailbox.
  const readMessage = useCallback(
    async (sourceId: string, signal: AbortSignal, original = false): Promise<OpenedOverviewMessage> => {
      try {
        const opened = await (original ? MailFollowupsService.open : MailFollowupsService.summary)(box, sourceId, signal);
        return { summary: "summary" in opened && typeof opened.summary === "string" ? opened.summary : undefined, sourceId, subject: opened.subject || null, sender: opened.sender || null, receivedAt: null, unread: false, body: opened.body, bodyTruncated: opened.body_truncated };
      } catch (error) {
        if (aborted(error)) throw new MailOverviewError("aborted");
        throw new MailOverviewError("retryable", { cause: error });
      }
    },
    [box],
  );

  const draftInfo = useMemo(() => {
    const map = new Map<string, { title: string; expectation: string }>();
    for (const item of session?.brief?.attention ?? []) {
      map.set(item.id, {
        title: item.title,
        expectation: item.kind === "follow_up" ? `Ask for this outstanding item: ${item.title}` : `Reply to this message: ${item.title}`,
      });
    }
    for (const item of session?.brief?.updates ?? []) map.set(item.id, { title: item.title, expectation: `Thank them: ${item.title}` });
    return map;
  }, [session?.brief]);

  if (!session || !brief) return null;
  const ownerInitial = (box.address || "").trim().charAt(0).toUpperCase() || "Y";
  return (
    <>
      <MailBriefPanel
        inlineSuggestions
        brief={brief}
        completed={completed}
        ownerInitial={ownerInitial}
        draftBusy={null}
        draftFailure={null}
        onWhy={setWhy}
        onDraft={(request: DraftRequest) => {
          const info = draftInfo.get(request.key);
          onDraft({ sourceId: request.sourceId, title: info?.title ?? "Follow up", expectation: info?.expectation ?? "Reply to this message." });
        }}
        onOpenReceipt={onOpenReceipt}
        onViewSent={(item: CompletedItem) =>
          setWhy({
            title: item.title,
            evidence: [{ sourceId: item.sourceId, from: item.viewLabel ? (item.to ?? "Them") : "You", on: noDate, direction: item.viewLabel ? "received" : "sent", quote: "" }],
            openFirst: true,
          })
        }
        onOpenFollowups={onOpenFollowups}
        onRetry={() => {
          retry?.();
          setRevision((value) => value + 1);
        }}
        onReconnect={onReconnect}
        onUnlock={onUnlock}
      />
      <section className={styles.section} aria-label="Mail tools">
        <div className={styles.tools}>
          <button
            type="button"
            className={styles.toolButton}
            aria-expanded={toolsOpen}
            aria-controls="mail-tools-panel"
            onClick={() => setToolsOpen((open) => !open)}
            data-testid="mail-tools-toggle"
          >
            <SearchIcon aria-hidden="true" className="size-4" />
            Search and recent mail
          </button>
        </div>
        {toolsOpen ? (
          <PrivateMailTools
            mailbox={box}
            onOpen={(row) =>
              setWhy({
                title: row.subject || "(No subject)",
                evidence: [{ sourceId: row.source, from: row.sender || "Unknown sender", on: noDate, direction: "received", quote: "" }],
                openFirst: true,
              })
            }
          />
        ) : null}
      </section>
      <MailWhySheet
        target={why}
        vaultOwnerToken={null}
        expectedAccount={mailbox.accountId}
        readMessage={readMessage}
        onClose={() => setWhy(null)}
        onReconnect={onReconnect}
        onUnlock={onUnlock}
      />
    </>
  );
}
