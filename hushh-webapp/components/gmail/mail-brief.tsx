"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
  Mail,
  PenLine,
  TrendingUp,
  Workflow,
} from "@/components/icons";
import type { ReactNode } from "react";

import type {
  AttentionItem,
  CompletedItem,
  MailBrief,
  MailCompleted,
  UpdateItem,
} from "@/lib/mail/mail-brief-client";
import {
  formatSentStamp,
  formatUpdatedTime,
  mailBriefFailureCopy,
  type MailFailureCopy,
} from "@/lib/mail/mail-overview-copy";
import type { ReceiptPriceUpdate } from "@/lib/mail/receipt-price-update";
import type { BriefPart } from "@/lib/mail/use-mail-brief";
import styles from "./mail-brief.module.css";
import type { WhyTarget } from "./mail-brief-why";

/** What a draft button asks for. `key` ties the button to its busy and failure state. */
export type DraftRequest = { key: string; sourceId: string; draft: string | null };

/** How many attention cards the Overview shows before "All N in Follow-ups". */
export const OVERVIEW_ATTENTION_LIMIT = 3;

function initials(name: string): string {
  const parts = name.replace(/[<>"]/g, "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  const letters = last ? `${first.charAt(0)}${last.charAt(0)}` : first.slice(0, 2);
  return (letters || "?").toUpperCase();
}

function firstName(name: string): string {
  const head = (name.split(/[,<]/)[0] ?? "").trim().split(/\s+/)[0] ?? "";
  return head || "them";
}

const DRAFT_LABEL = { draft_reply: "Draft reply", draft_followup: "Draft follow-up" } as const;

export function AttentionCard({
  scope,
  item,
  ownerInitial,
  primary,
  busy,
  failure,
  onWhy,
  onDraft,
}: {
  /** Which surface this card is on, so the same item on two retained panes never shares an id. */
  scope: "overview" | "followups";
  item: AttentionItem;
  ownerInitial: string;
  primary: boolean;
  busy: boolean;
  failure: string | null;
  onWhy: (target: WhyTarget) => void;
  onDraft: (request: DraftRequest) => void;
}) {
  const label = item.context
    ? `${item.context} · ${item.kind === "follow_up" ? "Follow-up" : "Reply"}`
    : item.person;
  const titleId = `brief-card-${scope}-${item.id}`;
  const why = () => onWhy({ title: item.title, reason: item.reason, evidence: item.evidence });
  return (
    <li className={styles.cardItem}>
      <article className={styles.card} aria-labelledby={titleId} data-testid="attention-card">
        <p className={styles.cardLabel}>{label}</p>
        <h3 id={titleId} className={styles.cardTitle}>
          {item.title}
        </h3>
        <hr className={styles.rule} />
        <div className={styles.meta}>
          <div className={styles.people} aria-hidden="true">
            <span className={styles.person}>{initials(item.person)}</span>
            <span className={styles.person}>{ownerInitial}</span>
          </div>
          <div className={styles.facts}>
            {item.due ? (
              <span className={styles.fact} data-testid="attention-due">
                <FileText aria-hidden="true" className="size-4 shrink-0" />
                <span>{item.due.label}</span>
              </span>
            ) : null}
            {item.term ? (
              <span className={styles.fact} data-testid="attention-term">
                {!item.due ? <FileText aria-hidden="true" className="size-4 shrink-0" /> : null}
                <span>{item.term}</span>
              </span>
            ) : null}
            <button type="button" className={styles.link} onClick={why} data-testid="why-this">
              <Workflow aria-hidden="true" className="size-4" />
              Why this?
            </button>
          </div>
        </div>
        <button
          type="button"
          className={`${styles.pill} ${primary ? styles.pillPrimary : ""}`}
          disabled={busy}
          aria-busy={busy}
          onClick={() =>
            onDraft({ key: item.id, sourceId: item.action.sourceId, draft: item.action.draft })
          }
          data-testid="attention-action"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <PenLine aria-hidden="true" className="size-4" />
          )}
          {busy ? "Preparing…" : DRAFT_LABEL[item.action.kind]}
        </button>
        {failure ? (
          <p className={styles.fail} role="alert">
            {failure}
          </p>
        ) : null}
      </article>
    </li>
  );
}

function SectionState({
  failure,
  children,
  onRetry,
  onReconnect,
  onUnlock,
}: {
  failure?: MailFailureCopy | null;
  children?: ReactNode;
  onRetry: () => void;
  onReconnect: () => void;
  onUnlock: () => void;
}) {
  return (
    <div className={styles.state} role={failure ? "alert" : "status"}>
      <p>{failure ? failure.message : children}</p>
      {failure?.action ? (
        <button
          type="button"
          className={styles.link}
          onClick={
            failure.action === "retry" ? onRetry : failure.action === "reconnect" ? onReconnect : onUnlock
          }
        >
          {failure.action === "retry" ? "Try again" : failure.action === "reconnect" ? "Reconnect" : "Unlock"}
        </button>
      ) : null}
    </div>
  );
}

const UPDATE_ICON = {
  approval: CheckCircle2,
  confirmation: CheckCircle2,
  change: ArrowUpRight,
  received: Mail,
} as const;

function UpdateRow({
  item,
  busy,
  failure,
  onWhy,
  onDraft,
}: {
  item: UpdateItem;
  busy: boolean;
  failure: string | null;
  onWhy: (target: WhyTarget) => void;
  onDraft: (request: DraftRequest) => void;
}) {
  const Icon = UPDATE_ICON[item.kind];
  const thank = item.action.kind === "thank" ? item.action : null;
  return (
    <li className={styles.row} data-testid="update-row">
      <span className={styles.rowIcon} aria-hidden="true">
        <Icon className="size-5" />
      </span>
      <div className={styles.rowText}>
        <h3 className={styles.rowTitle}>{item.title}</h3>
        <p className={styles.rowLine}>{item.line}</p>
        <button
          type="button"
          className={styles.link}
          onClick={() => onWhy({ title: item.title, reason: item.line, evidence: item.evidence })}
          data-testid="why-this"
        >
          <Workflow aria-hidden="true" className="size-4" />
          Why this?
        </button>
        {failure ? (
          <p className={styles.fail} role="alert">
            {failure}
          </p>
        ) : null}
      </div>
      {thank ? (
        <div className={styles.rowAction}>
          <button
            type="button"
            className={styles.link}
            disabled={busy}
            aria-busy={busy}
            onClick={() => onDraft({ key: item.id, sourceId: thank.sourceId, draft: thank.draft })}
            data-testid="update-action"
          >
            {busy ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <PenLine aria-hidden="true" className="size-4" />
            )}
            {busy ? "Preparing…" : `Thank ${firstName(item.person)}`}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ReceiptUpdateRow({
  update,
  onOpen,
}: {
  update: ReceiptPriceUpdate;
  onOpen: (findingId: string) => void;
}) {
  return (
    <li className={styles.row} data-testid="receipt-update-row">
      <span className={styles.rowIcon} aria-hidden="true">
        <TrendingUp className="size-5" />
      </span>
      <div className={styles.rowText}>
        <h3 className={styles.rowTitle}>{update.title}</h3>
        <p className={styles.rowLine}>{update.line}</p>
      </div>
      <div className={styles.rowAction}>
        <button
          type="button"
          className={styles.link}
          onClick={() => onOpen(update.findingId)}
          data-testid="open-in-receipts"
        >
          Open in Receipts
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </li>
  );
}

function CompletedRow({ item, onView }: { item: CompletedItem; onView: (item: CompletedItem) => void }) {
  return (
    <li className={styles.row} data-testid="completed-row">
      <span className={`${styles.rowIcon} ${styles.rowDone}`} aria-hidden="true">
        <CheckCircle2 className="size-5" />
      </span>
      <div className={styles.rowText}>
        <h3 className={styles.rowTitle}>{item.title}</h3>
        {item.line ? <p className={styles.rowLine}>{item.line}</p> : null}
        <p className={styles.rowStamp}>{formatSentStamp(item.sentAt)}</p>
        <button
          type="button"
          className={styles.link}
          onClick={() => onView(item)}
          data-testid="view-sent-email"
        >
          {item.viewLabel ?? "View sent email"}
        </button>
      </div>
    </li>
  );
}

export type MailBriefSectionsProps = {
  inlineSuggestions?: boolean;
  brief: BriefPart<MailBrief>;
  completed: BriefPart<MailCompleted>;
  receiptUpdates: ReceiptPriceUpdate[];
  ownerInitial: string;
  /** The draft being prepared, by card key. Only one runs at a time. */
  draftBusy: string | null;
  draftFailure: { key: string; message: string } | null;
  onWhy: (target: WhyTarget) => void;
  onDraft: (request: DraftRequest) => void;
  onOpenReceipt: (findingId: string) => void;
  onViewSent: (item: CompletedItem) => void;
  onOpenFollowups: () => void;
  onRetry: () => void;
  onReconnect: () => void;
  onUnlock: () => void;
};

export function MailBriefSections(props: MailBriefSectionsProps) {
  const { brief, completed, receiptUpdates } = props;
  const failureOf = (part: BriefPart<unknown>) =>
    part.error ? mailBriefFailureCopy(part.error, { kept: Boolean(part.data) }) : null;
  const briefFailure = failureOf(brief);
  const completedFailure = failureOf(completed);
  const attention = brief.data?.attention ?? [];
  const updates = brief.data?.updates ?? [];
  const [expanded, setExpanded] = useState(false);
  const shown = props.inlineSuggestions && expanded ? attention : attention.slice(0, OVERVIEW_ATTENTION_LIMIT);
  const state = { onRetry: props.onRetry, onReconnect: props.onReconnect, onUnlock: props.onUnlock };
  const briefLoading = brief.status === "loading" && !brief.data;
  const fetchedAt = brief.fetchedAt || Infinity;

  return (
    <div className={styles.brief} data-testid="mail-brief">
      <section className={styles.section} aria-labelledby="brief-attention-title">
        <div className={styles.head}>
          <h2 id="brief-attention-title" className={styles.h2}>
            Needs your attention
          </h2>
          {attention.length > OVERVIEW_ATTENTION_LIMIT ? (
            <button
              type="button"
              className={styles.link}
              onClick={props.inlineSuggestions ? () => setExpanded(!expanded) : props.onOpenFollowups}
              data-testid="all-in-followups"
            >
              {props.inlineSuggestions ? (expanded ? "Show fewer" : `Show all ${attention.length}`) : `All ${attention.length} in Follow-ups`}
            </button>
          ) : null}
        </div>
        {briefLoading ? (
          <p className={styles.state} role="status" aria-label="Checking recent mail">Checking recent mail…</p>
        ) : null}
        {briefFailure && !brief.data ? <SectionState failure={briefFailure} {...state} /> : null}
        {briefFailure && brief.data ? (
          <p className={styles.fail} role="alert">
            {briefFailure.message}
          </p>
        ) : null}
        {brief.data && shown.length ? (
          <ul className={styles.cards} data-testid="attention-list">
            {shown.map((item, index) => (
              <AttentionCard
                key={item.id}
                scope="overview"
                item={item}
                ownerInitial={props.ownerInitial}
                primary={index === 0}
                busy={props.draftBusy === item.id}
                failure={props.draftFailure?.key === item.id ? props.draftFailure.message : null}
                onWhy={props.onWhy}
                onDraft={props.onDraft}
              />
            ))}
          </ul>
        ) : null}
        {brief.data?.incomplete?.includes("attention") ? <SectionState {...state}>Some actions could not be verified.</SectionState> : null}
        {brief.data && !brief.data.incomplete?.includes("attention") && !attention.length ? (
          <SectionState {...state}>
            {brief.data.coverage.messages === 0
              ? "No recent mail to check yet."
              : `No action found in the ${brief.data.coverage.messages} ${
                  brief.data.coverage.messages === 1 ? "message" : "messages"
                } checked from the last ${brief.data.coverage.windowDays} days.`}
          </SectionState>
        ) : null}
      </section>

      <div className={styles.lower}>
        <section className={styles.section} aria-labelledby="brief-updates-title">
          <div className={styles.head}>
            <h2 id="brief-updates-title" className={styles.h2}>
              Recent updates
            </h2>
          </div>

          {briefFailure && !brief.data ? <SectionState failure={briefFailure} {...state} /> : null}
          {(brief.data || receiptUpdates.length) && (updates.length || receiptUpdates.length) ? (
            <ul className={styles.panel} data-testid="updates-list">
              {updates.map((item) => (
                <UpdateRow
                  key={item.id}
                  item={item}
                  busy={props.draftBusy === item.id}
                  failure={props.draftFailure?.key === item.id ? props.draftFailure.message : null}
                  onWhy={props.onWhy}
                  onDraft={props.onDraft}
                />
              ))}
              {receiptUpdates.map((update) => (
                <ReceiptUpdateRow key={update.findingId} update={update} onOpen={props.onOpenReceipt} />
              ))}
            </ul>
          ) : null}
          {brief.data?.incomplete?.includes("updates") ? <SectionState {...state}>Some updates could not be verified.</SectionState> : null}
          {brief.data && !brief.data.incomplete?.includes("updates") && !updates.length && !receiptUpdates.length ? (
            <SectionState {...state}>No changes to report.</SectionState>
          ) : null}
        </section>

        <section className={styles.section} aria-labelledby="brief-completed-title">
          <div className={styles.head}>
            <h2 id="brief-completed-title" className={styles.h2}>
              Recently completed
            </h2>
          </div>
          {completed.status === "loading" && !completed.data ? (
            <div className={styles.skeleton} aria-busy="true" aria-label="Checking what was sent" />
          ) : null}
          {completedFailure && !completed.data ? <SectionState failure={completedFailure} {...state} /> : null}
          {completed.data?.items.length ? (
            <ul className={styles.panel} data-testid="completed-list">
              {completed.data.items.map((item) => (
                <CompletedRow key={item.id} item={item} onView={props.onViewSent} />
              ))}
            </ul>
          ) : null}
          {completed.data && !completed.data.items.length ? (
            <SectionState {...state}>{props.inlineSuggestions ? "No completed mail follow-ups in the last 30 days." : "Nothing sent through One in the last 30 days."}</SectionState>
          ) : null}
        </section>
      </div>

      {Number.isFinite(fetchedAt) ? (
        <p className={styles.updated} data-testid="brief-updated">
          Updated {formatUpdatedTime(fetchedAt)}
          {" · "}
          <button
            type="button"
            className={styles.link}
            onClick={props.onRetry}
            disabled={brief.refreshing || completed.refreshing}
            data-testid="brief-refresh"
          >
            {brief.refreshing || completed.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </p>
      ) : null}
    </div>
  );
}
