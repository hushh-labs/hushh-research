"use client";

import { ChevronRight } from "@/components/icons";
import type { MailBrief } from "@/lib/mail/mail-brief-client";
import { mailBriefFailureCopy } from "@/lib/mail/mail-overview-copy";
import type { BriefPart } from "@/lib/mail/use-mail-brief";
import { AttentionCard, type DraftRequest } from "./mail-brief";
import type { WhyTarget } from "./mail-brief-why";
import styles from "./mail-brief.module.css";

/**
 * Every item that needs the owner, from the same read the Overview uses: no
 * second request, so "All N in Follow-ups" opens exactly those N. Requests for
 * the owner's personal details live under here too.
 */
export function MailFollowups({
  brief,
  ownerInitial,
  draftBusy,
  draftFailure,
  onWhy,
  onDraft,
  onOpenKyc,
  onRetry,
  onReconnect,
  onUnlock,
}: {
  brief: BriefPart<MailBrief>;
  ownerInitial: string;
  draftBusy: string | null;
  draftFailure: { key: string; message: string } | null;
  onWhy: (target: WhyTarget) => void;
  onDraft: (request: DraftRequest) => void;
  onOpenKyc: () => void;
  onRetry: () => void;
  onReconnect: () => void;
  onUnlock: () => void;
}) {
  const items = brief.data?.attention ?? [];
  const failure = brief.error ? mailBriefFailureCopy(brief.error, { kept: Boolean(brief.data) }) : null;
  const loading = brief.status === "loading" && !brief.data;
  return (
    <div className={styles.brief} data-testid="mail-followups">
      <section className={styles.section} aria-labelledby="followups-title">
        <div className={styles.head}>
          <h2 id="followups-title" className={styles.h2}>
            Follow-ups
          </h2>
          {brief.data ? (
            <span className={styles.updated} data-testid="followups-count">
              {items.length === 0 ? "None waiting" : `${items.length} ${items.length === 1 ? "needs" : "need"} you`}
            </span>
          ) : null}
        </div>
        {loading ? <div className={styles.skeleton} aria-busy="true" aria-label="Checking your recent mail" /> : null}
        {failure ? (
          <div className={styles.state} role="alert">
            <p>{failure.message}</p>
            {failure.action ? (
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
        ) : null}
        {items.length ? (
          <ul className={styles.cards} data-testid="followups-list">
            {items.map((item, index) => (
              <AttentionCard
                key={item.id}
                scope="followups"
                item={item}
                ownerInitial={ownerInitial}
                primary={index === 0}
                busy={draftBusy === item.id}
                failure={draftFailure?.key === item.id ? draftFailure.message : null}
                onWhy={onWhy}
                onDraft={onDraft}
              />
            ))}
          </ul>
        ) : null}
        {brief.data && !items.length ? (
          <div className={styles.state} role="status">
            <p>Nothing is waiting on you right now.</p>
          </div>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby="details-title">
        <div className={styles.head}>
          <h2 id="details-title" className={styles.h2}>
            Requests for your details
          </h2>
        </div>
        <div className={styles.state}>
          <p>See who has asked for your personal details, and review every reply before it is sent.</p>
          <button type="button" className={styles.link} onClick={onOpenKyc} data-testid="open-kyc">
            Review requests
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </div>
      </section>
    </div>
  );
}
