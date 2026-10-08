"use client";

import { useState, type ReactNode } from "react";

import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  InfoIcon,
  MemoryAgentIcon,
  WarningIcon,
} from "@/components/icons";
import { ReservedOfferRows } from "@/components/agent/reserved-offer-rows";
import { Button } from "@/components/ui/button";
import { describeOwnerMemoryReview } from "@/lib/agent/agent-pkm-explicit-save";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import {
  pkmSaveReceiptWrote,
  type PkmSaveReceipt,
  type PkmSaveReceiptCoverage,
  type PkmSaveReceiptCoverageLine,
  type PkmSaveReceiptItemOutcome,
} from "@/lib/agent/pkm-save-receipt";
import type { ReservedOfferItem } from "@/lib/pkm/reserved-offer";

/**
 * The receipt card for an explicit "save this to my memory" request.
 *
 * Every number is a server-acknowledged commit or a preparation outcome
 * (lib/agent/pkm-save-receipt.ts); nothing here is optimistic. Geometry is a
 * contract, checked by e2e/memory-save-card.layout.spec.ts: 16 px symmetric
 * insets, 8 px gaps, a 4-column count grid of equal tiles, tabular numerals,
 * and category counts in fixed-width columns so digits line up row to row.
 *
 * A save that ran as a resumable job also carries line coverage: every line of
 * the owner's text, where it was saved, why it was not, or "Not yet saved"
 * with Retry. Checked by e2e/memory-save-coverage.layout.spec.ts.
 */

const OUTCOME_LABEL: Record<PkmSaveReceiptItemOutcome, string> = {
  saved: "New",
  updated: "Updated",
  merged: "Merged",
  unchanged: "Already known",
  needs_owner: "Needs your OK",
  failed: "Not saved",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function title(receipt: PkmSaveReceipt): string {
  const state = receipt.coverage?.jobState;
  if (state === "paused_locked" || state === "paused_offline" || state === "running") {
    return pkmSaveReceiptWrote(receipt) > 0 ? "Saving paused, partly saved" : "Saving paused";
  }
  if (pkmSaveReceiptWrote(receipt) > 0) {
    return receipt.failed || receipt.unprepared || receipt.unreadable || receipt.excluded || receipt.needsOwner
      ? "Partly saved to Memory"
      : "Saved to Memory";
  }
  if (receipt.unchanged > 0 && receipt.failed === 0 && receipt.unprepared === 0 && receipt.unreadable === 0 && receipt.excluded === 0) return "Already in Memory";
  if (receipt.needsOwner > 0 && receipt.failed === 0 && receipt.unprepared === 0 && receipt.unreadable === 0 && receipt.excluded === 0) return "Waiting for your OK";
  if (receipt.failed > 0 || receipt.unprepared > 0 || receipt.unreadable > 0 || receipt.excluded > 0) return "Couldn’t save everything";
  return "Nothing to save";
}

function footnotes(receipt: PkmSaveReceipt): string[] {
  const notes: string[] = [];
  if (receipt.unchanged) notes.push(`${plural(receipt.unchanged, "detail was", "details were")} already in Memory.`);
  if (receipt.failed) notes.push(`${plural(receipt.failed, "detail", "details")} couldn’t be saved.`);
  if (receipt.unprepared) {
    notes.push(`${plural(receipt.unprepared, "section", "sections")} may have missing details. Review the original text and retry.`);
  }
  if (receipt.unreadable) notes.push(`${plural(receipt.unreadable, "detail", "details")} from an incomplete review were not saved.`);
  if (receipt.excluded) notes.push(`${plural(receipt.excluded, "detail was", "details were")} excluded for safety.`);
  if (receipt.updated) notes.push("Earlier values are kept in your history.");
  return notes;
}

const COUNT_TILES: Array<{ key: "saved" | "updated" | "merged" | "skipped"; label: string }> = [
  { key: "saved", label: "Saved" },
  { key: "updated", label: "Updated" },
  { key: "merged", label: "Merged" },
  { key: "skipped", label: "Skipped" },
];

const LINE_STATUS: Record<PkmSaveReceiptCoverageLine["status"], string> = {
  saved: "Saved",
  not_memory: "Not saved",
  structure: "Heading",
  held: "Held back",
  not_yet_saved: "Not yet saved",
};

const LINE_REASON: Record<NonNullable<PkmSaveReceiptCoverageLine["reason"]>, string> = {
  duplicate: "Repeats another line",
  disclaimer: "A disclaimer, not a detail",
  already_known: "Already in Memory",
  heading: "Section heading, kept as context",
  formatting: "Formatting only",
  needs_owner: "Waiting for your OK",
  excluded: "Kept out for safety",
  left_out: "One left this out",
};

/** Where the line went, or why it did not, in one short phrase. */
function lineDetail(line: PkmSaveReceiptCoverageLine): string {
  if (line.status === "saved") {
    const places = [...new Set(line.savedTo.map((place) => place.path ? `${place.domainLabel} > ${place.path}` : place.domainLabel))];
    return places.length ? `Saved in ${places.join(", ")}` : "Saved";
  }
  if (line.status === "not_yet_saved") return "Not yet saved";
  return line.reason ? LINE_REASON[line.reason] : LINE_STATUS[line.status];
}

function LineGlyph({ status }: { status: PkmSaveReceiptCoverageLine["status"] }) {
  const common = { size: 20, "aria-hidden": true as const, className: "shrink-0" };
  if (status === "saved") return <CheckCircleIcon {...common} className="shrink-0 text-[color:var(--tone-green)]" />;
  if (status === "held") return <WarningIcon {...common} className="shrink-0 text-[color:var(--tone-orange)]" />;
  if (status === "not_yet_saved") {
    return <ArrowsClockwiseIcon {...common} weight="duotone" className="shrink-0 text-[color:var(--tone-orange)]" />;
  }
  return <InfoIcon {...common} className="shrink-0 text-foreground/50" />;
}

function coverageSummary(coverage: PkmSaveReceiptCoverage): string {
  return `${coverage.accountedLines} of ${plural(coverage.totalLines, "line", "lines")} accounted for`;
}

function gapPrompt(coverage: PkmSaveReceiptCoverage): string {
  const paused = coverage.jobState === "paused_locked"
    ? " Saving continues when you unlock."
    : coverage.jobState === "paused_offline"
      ? " Saving continues when you are back online."
      : "";
  return `${plural(coverage.notYetSavedLines, "line is", "lines are")} not yet saved.${paused}`;
}

// The shared flat app-card contract (app/globals.css), theme-aware in light and dark.
const SURFACE =
  "rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 text-foreground";
// The data surface equals the card surface in dark, so tiles take the neutral fill there.
const TILE = "rounded-xl bg-[color:var(--app-card-surface-data)] dark:bg-[color:var(--app-neutral-fill)]";
const INSET = "rounded-xl border border-[color:var(--app-card-border-standard)]";

export function AgentMemorySaveCard({
  receipt,
  memoryHref,
  renderLink,
  onConfirmNeedsOwner,
  onOpenOffer,
  onRetry,
  pendingCards = [],
  canConfirmNeedsOwner = false,
}: {
  receipt: PkmSaveReceipt;
  memoryHref: string;
  /** The host's router link; a plain anchor is used when absent. */
  renderLink?: (props: { href: string; className: string; children: string }) => ReactNode;
  onConfirmNeedsOwner?: (reviewedCards: readonly AgentPkmPreviewCard[]) => Promise<void>;
  /** Opens the app screen that owns a fact; the prefill travels in memory only. */
  onOpenOffer?: (offer: ReservedOfferItem) => void;
  /** Continue the save job for the lines not yet saved. */
  onRetry?: () => Promise<void>;
  /** Full proposed details, held only in this unlocked chat session. */
  pendingCards?: readonly AgentPkmPreviewCard[];
  canConfirmNeedsOwner?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const reviewComplete = pendingCards.length === receipt.needsOwner &&
    pendingCards.every((card) => describeOwnerMemoryReview(card) !== null);
  const notes = footnotes(receipt);
  const coverage = receipt.coverage;
  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    setRetryError(false);
    try {
      await onRetry();
    } catch {
      setRetryError(true);
    } finally {
      setRetrying(false);
    }
  };
  const linkClass =
    "inline-flex min-h-12 items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
  const confirm = async () => {
    if (!onConfirmNeedsOwner || !canConfirmNeedsOwner || !reviewComplete) return;
    setConfirming(true);
    setConfirmError(false);
    try {
      await onConfirmNeedsOwner(pendingCards);
    } catch {
      setConfirmError(true);
    } finally {
      setConfirming(false);
    }
  };
  return (
    <section aria-label="Memory save" className={`${SURFACE} motion-step-enter flex flex-col gap-3`} data-testid="memory-save-card">
      <header className="flex h-6 items-center gap-2">
        <MemoryAgentIcon size={20} aria-hidden="true" className="shrink-0" />
        <p className="text-sm font-semibold leading-6" role="status">
          {title(receipt)}
        </p>
      </header>

      <dl className="grid grid-cols-4 gap-2" data-testid="memory-save-counts">
        {COUNT_TILES.map((tile) => (
          <div
            key={tile.key}
            className={`${TILE} flex flex-col-reverse items-center px-2 py-2`}
            data-testid="memory-save-count"
          >
            <dt className="text-xs leading-4 text-foreground/70">{tile.label}</dt>
            <dd className="text-xl font-semibold leading-8 tabular-nums">{receipt[tile.key]}</dd>
          </div>
        ))}
      </dl>

      {receipt.domains.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Categories saved" data-testid="memory-save-categories">
          {receipt.domains.map((domain) => (
            <span key={domain.domain} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              {domain.label} <span className="tabular-nums">{domain.saved + domain.updated + domain.merged}</span>
            </span>
          ))}
        </div>
      ) : null}

      {notes.length ? (
        <ul className="flex flex-col gap-1 text-xs leading-4 text-foreground/70" data-testid="memory-save-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {receipt.offers?.length && onOpenOffer ? (
        <div className="flex flex-col gap-2" data-testid="memory-save-offers">
          <p className="text-xs leading-4 text-foreground/70">
            {receipt.offers.length === 1 ? "This belongs in an app. Finish it there:" : "These belong in an app. Finish them there:"}
          </p>
          <ReservedOfferRows offers={receipt.offers} onOpen={onOpenOffer} />
        </div>
      ) : null}

      {receipt.needsOwner > 0 ? (
        <div className={`${INSET} flex flex-col gap-2 p-3`} data-testid="memory-save-needs-owner">
          <p className="text-sm leading-5">
            Review {plural(receipt.needsOwner, "detail", "details")} before saving.
          </p>
          {pendingCards.length ? (
            <div className="max-h-56 overflow-y-auto rounded-lg bg-[color:var(--app-card-surface-data)] p-2" data-testid="memory-save-owner-review">
              <ul className="space-y-2">
                {pendingCards.map((card) => {
                  const review = describeOwnerMemoryReview(card);
                  return (
                    <li key={card.card_id} className="break-words rounded-md bg-background p-2 text-xs leading-5">
                      <p>{card.source_text}</p>
                      {review ? (
                        <>
                          <p className="mt-2 font-medium">{review.destination}</p>
                          <p className="mt-2 font-medium">Proposed details</p>
                          <pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{review.proposedPayload}</pre>
                          {review.recipientLabels.length > 0 ? (
                            <p className="mt-2 font-medium text-destructive">
                              This change enters the next shared export for: {review.recipientLabels.join(", ")}.
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <p className="mt-2 text-destructive">The proposed change or affected people could not be verified. Prepare this detail again before saving.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">This review is no longer available in this chat session. Ask One to retry the save.</p>
          )}
          {confirmError ? (
            <p className="text-xs leading-4 text-destructive" role="alert">
              That didn’t save. Nothing changed. Try again.
            </p>
          ) : null}
          {onConfirmNeedsOwner && pendingCards.length > 0 ? (
            <Button size="standard" onClick={() => void confirm()} isLoading={confirming} disabled={confirming || !canConfirmNeedsOwner || !reviewComplete}>
              {`Save ${receipt.needsOwner === 1 ? "it" : `these ${receipt.needsOwner}`} too`}
            </Button>
          ) : null}
        </div>
      ) : null}

      {coverage && coverage.notYetSavedLines > 0 ? (
        <div className={`${INSET} flex flex-col gap-2 p-3`} data-testid="memory-save-gaps">
          <p className="text-sm leading-5">{gapPrompt(coverage)}</p>
          {retryError ? (
            <p className="text-xs leading-4 text-destructive" role="alert">
              That didn’t continue. Nothing was lost. Try again.
            </p>
          ) : null}
          {onRetry ? (
            <Button size="standard" variant="secondary" onClick={() => void retry()} isLoading={retrying} disabled={retrying}>
              {`Retry ${plural(coverage.notYetSavedLines, "line", "lines")}`}
            </Button>
          ) : null}
        </div>
      ) : null}

      {receipt.items.length ? (
        <details className="group" data-testid="memory-save-details">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-1 text-sm font-medium text-primary marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
            Show what changed
            <CaretDownIcon
              aria-hidden="true"
              className="size-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          {receipt.domains.length ? (
            <div
              className="grid grid-cols-[minmax(0,1fr)_repeat(3,3.5rem)] gap-x-2 text-xs leading-4"
              data-testid="memory-save-domains"
              role="table"
              aria-label="Changes by category"
            >
              <div role="row" className="contents text-foreground/70">
                <span role="columnheader" className="flex h-8 items-center">Category</span>
                <span role="columnheader" className="flex h-8 items-center justify-end">New</span>
                <span role="columnheader" className="flex h-8 items-center justify-end">Updated</span>
                <span role="columnheader" className="flex h-8 items-center justify-end">Merged</span>
              </div>
              {receipt.domains.map((domain) => (
                <div role="row" className="contents" key={domain.domain} data-testid="memory-save-domain-row">
                  <span role="cell" className="flex h-8 min-w-0 items-center truncate">{domain.label}</span>
                  {([domain.saved, domain.updated, domain.merged] as const).map((count, index) => (
                    <span
                      role="cell"
                      key={index}
                      className="flex h-8 items-center justify-end tabular-nums"
                      data-testid="memory-save-domain-count"
                    >
                      {count}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
          <ul className="mt-2 flex flex-col gap-2" data-testid="memory-save-items">
            {receipt.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-2 text-xs leading-4">
                <span className="min-w-0 text-foreground/85">
                  <span className="text-foreground/60">{item.domainLabel}: </span>
                  {item.text}
                </span>
                <span className="shrink-0 text-foreground/70">{OUTCOME_LABEL[item.outcome]}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {coverage && coverage.lines.length ? (
        <details className="group/coverage" data-testid="memory-save-coverage">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-1 text-sm font-medium text-primary marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
            Show line by line
            <CaretDownIcon
              aria-hidden="true"
              className="size-4 transition-transform duration-150 group-open/coverage:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <p className="flex h-8 items-center text-xs leading-4 text-foreground/70 tabular-nums" data-testid="memory-save-coverage-summary">
            {coverageSummary(coverage)}
          </p>
          <ol
            className="max-h-96 overflow-y-auto rounded-xl bg-[color:var(--app-card-surface-data)] px-3 dark:bg-[color:var(--app-neutral-fill)]"
            aria-label="Each line of your text"
            data-testid="memory-save-coverage-lines"
          >
            {coverage.lines.map((line) => (
              <li
                key={line.line}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-2 py-2 shadow-[inset_0_1px_0_0_var(--app-card-border-standard)] first:shadow-none"
                data-testid="memory-save-coverage-line"
                data-status={line.status}
              >
                <span className="flex h-5 items-center"><LineGlyph status={line.status} /></span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="break-words text-xs leading-5 text-foreground/85">
                    <span className="sr-only">{`Line ${line.line}: `}</span>
                    {line.text}
                  </span>
                  <span className="text-xs leading-4 text-foreground/70" data-testid="memory-save-coverage-detail">
                    {lineDetail(line)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <footer className="flex items-center">
        {renderLink ? (
          renderLink({ href: memoryHref, className: linkClass, children: "View Memory" })
        ) : (
          <a href={memoryHref} className={linkClass}>
            View Memory
          </a>
        )}
      </footer>
    </section>
  );
}
