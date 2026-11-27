"use client";

import { Fragment, useEffect, useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { formatMinor } from "@/lib/mail/receipt-money";
import { type NoticeEvidence, type NoticeFinding, type NoticeSource, ROLE_LABEL } from "@/lib/mail/receipt-notice";
import { shortDate } from "@/lib/mail/receipt-tracking-present";
import { cn } from "@/lib/utils";
import mailStyles from "../mail-workspace.module.css";
import { useReceiptNotice } from "./receipt-notice-context";
import styles from "./receipts.module.css";

const money = (finding: NoticeFinding, key: string): string | null => {
  const minorValue = finding.facts[key];
  const currency = finding.facts.currency;
  return typeof minorValue === "number" && typeof currency === "string" ? formatMinor(minorValue, currency) : null;
};

/** The facts the server computed, each in one line. Nothing here is the model's own arithmetic. */
export function noticeFacts(finding: NoticeFinding): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string | null) => { if (value) out.push({ label, value }); };
  const f = finding.facts;
  switch (finding.kind) {
    case "price_rise":
      add("Last paid", money(finding, "last_paid_minor"));
      add(f.new_is_announced ? "New price" : "Latest bill", money(finding, "new_minor"));
      add(f.base_kind === "agreed" ? "Agreed price" : "Usual bill", money(finding, "base_minor"));
      add("Rise", typeof f.percent === "string" ? `${f.percent}%` : null);
      add("From", typeof f.effective_on === "string" && f.effective_on ? shortDate(f.effective_on) : null);
      break;
    case "refund_followup":
      add("Promised", shortDate(String(f.promised_on ?? "")));
      add("Expected by", shortDate(String(f.promised_by ?? "")));
      add("Amount", money(finding, "amount_minor"));
      break;
    case "possible_duplicate":
      add("Amount", money(finding, "amount_minor"));
      add("First", shortDate(String(f.first_on ?? "")));
      add("Second", shortDate(String(f.second_on ?? "")));
      break;
    case "inactive_plan":
      add("Price", money(finding, "amount_minor") ? `${money(finding, "amount_minor")}${f.period === "monthly" ? " a month" : f.period === "yearly" ? " a year" : ""}` : null);
      add("Last paid", shortDate(String(f.last_paid_on ?? "")));
      break;
    default:
      break;
  }
  return out;
}

/** One short line under the evidence, only where it protects the owner from over-reading it. */
export function noticeCaveat(finding: NoticeFinding): string | null {
  if (finding.kind === "refund_followup") return "One reads your mail, not your bank. The refund may have arrived.";
  if (finding.kind === "inactive_plan" && finding.strength === "question") return "A general email isn’t proof you stopped using it.";
  if (finding.kind === "possible_duplicate" && finding.strength === "question") return "Two receipts don’t always mean two charges. Check both.";
  return null;
}

export function EvidenceList({ evidence, onOpen }: { evidence: readonly NoticeEvidence[]; onOpen: (item: NoticeEvidence) => void }) {
  return (
    <ul className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]" data-testid="notice-evidence">
      {evidence.map((item) => (
        <li key={`${item.evidenceId}:${item.role}`} className="space-y-1.5 px-4 py-3">
          <p className="text-[12px] leading-[18px] text-muted-foreground">
            {ROLE_LABEL[item.role]} · {item.from} · {shortDate(item.on)}
          </p>
          <p className="text-[14px] leading-[21px] text-foreground">“{item.quote}”</p>
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="min-h-11 text-[14px] font-medium text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          >
            View email
          </button>
        </li>
      ))}
    </ul>
  );
}

export function NoticeFacts({ finding }: { finding: NoticeFinding }) {
  const facts = noticeFacts(finding);
  if (!facts.length) return null;
  return (
    <dl className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 text-[13px]" data-testid="notice-facts">
      {facts.map((fact) => (
        <div key={fact.label} className="flex justify-between gap-3 py-2">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="font-medium tabular-nums">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Highlights the quoted passage inside the provider's own email, when it can be found there. */
function Highlighted({ text, quote }: { text: string; quote: string }) {
  const at = text.toLowerCase().indexOf(quote.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <Fragment>
      {text.slice(0, at)}
      <mark className="rounded bg-[color:var(--app-accent-surface)] px-0.5 text-foreground" data-testid="notice-quote-mark">{text.slice(at, at + quote.length)}</mark>
      {text.slice(at + quote.length)}
    </Fragment>
  );
}

type SourceState = { status: "loading" } | { status: "ready"; source: NoticeSource } | { status: "error"; message: string };

/** The exact email behind a finding, read fresh from the owner's own mailbox. */
export function NoticeSourceSheet({ target, onClose }: { target: NoticeEvidence | null; onClose: () => void }) {
  const notice = useReceiptNotice();
  const [state, setState] = useState<SourceState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const openKey = target?.openKey;
  useEffect(() => {
    if (!openKey || !notice) return;
    let current = true;
    setState({ status: "loading" });
    notice.openSource(openKey)
      .then((source) => { if (current) setState({ status: "ready", source }); })
      .catch(() => { if (current) setState({ status: "error", message: "Couldn’t open this email." }); });
    return () => { current = false; };
  // `notice` is stable per mailbox; the key and the retry counter are what should reopen it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, attempt]);
  return (
    <AdaptiveDetailSurface
      open={Boolean(target)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      eyebrow={target ? `${target.from} · ${shortDate(target.on)}` : undefined}
      headerTextOverflow="wrap"
      title={state.status === "ready" ? state.source.subject || target?.subject || "Email" : target?.subject || "Email"}
      surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
    >
      {target ? (
        <div className="space-y-3" data-testid="notice-source">
          <p className={cn("rounded-xl bg-[color:var(--app-accent-surface)] px-4 py-3 text-[14px] leading-[21px] text-foreground")}>“{target.quote}”</p>
          {state.status === "loading" ? <p className="text-[14px] text-muted-foreground" role="status">Opening the email…</p> : null}
          {state.status === "error" ? (
            <div className="space-y-2" role="alert">
              <p className="text-[14px] leading-[21px] text-muted-foreground">{state.message} Your saved receipts are unchanged.</p>
              <button type="button" onClick={() => setAttempt((value) => value + 1)} className={styles.secondaryPill}>Try again</button>
            </div>
          ) : null}
          {state.status === "ready" ? (
            <>
              <p className="text-[12px] leading-[18px] text-muted-foreground">
                {state.source.fromName ?? state.source.fromDomain ?? target.from}
                {state.source.receivedAt ? ` · ${shortDate(state.source.receivedAt.slice(0, 10), true)}` : ""}
              </p>
              <p className="whitespace-pre-wrap break-words text-[14px] leading-[22px] text-foreground" data-testid="notice-source-excerpt">
                <Highlighted text={state.source.excerpt} quote={target.quote} />
                {state.source.truncated ? " …" : ""}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </AdaptiveDetailSurface>
  );
}
