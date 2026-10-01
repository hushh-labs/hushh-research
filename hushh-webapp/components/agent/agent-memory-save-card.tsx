"use client";

import { useState, type ReactNode } from "react";

import { CaretDownIcon, MemoryAgentIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import {
  pkmSaveReceiptWrote,
  type PkmSaveReceipt,
  type PkmSaveReceiptItemOutcome,
} from "@/lib/agent/pkm-save-receipt";

/**
 * The receipt card for an explicit "save this to my memory" request.
 *
 * Every number is a server-acknowledged commit or a preparation outcome
 * (lib/agent/pkm-save-receipt.ts); nothing here is optimistic. Geometry is a
 * contract, checked by e2e/memory-save-card.layout.spec.ts: 16 px symmetric
 * insets, 8 px gaps, a 4-column count grid of equal tiles, tabular numerals,
 * and category counts in fixed-width columns so digits line up row to row.
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
  pendingCards = [],
}: {
  receipt: PkmSaveReceipt;
  memoryHref: string;
  /** The host's router link; a plain anchor is used when absent. */
  renderLink?: (props: { href: string; className: string; children: string }) => ReactNode;
  onConfirmNeedsOwner?: () => Promise<void>;
  /** Full proposed details, held only in this unlocked chat session. */
  pendingCards?: readonly AgentPkmPreviewCard[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const notes = footnotes(receipt);
  const linkClass =
    "inline-flex min-h-12 items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
  const confirm = async () => {
    if (!onConfirmNeedsOwner) return;
    setConfirming(true);
    setConfirmError(false);
    try {
      await onConfirmNeedsOwner();
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

      {receipt.needsOwner > 0 ? (
        <div className={`${INSET} flex flex-col gap-2 p-3`} data-testid="memory-save-needs-owner">
          <p className="text-sm leading-5">
            Review {plural(receipt.needsOwner, "detail", "details")} before saving.
          </p>
          {pendingCards.length ? (
            <div className="max-h-56 overflow-y-auto rounded-lg bg-[color:var(--app-card-surface-data)] p-2" data-testid="memory-save-owner-review">
              <ul className="space-y-2">
                {pendingCards.map((card) => (
                  <li key={card.card_id} className="break-words rounded-md bg-background p-2 text-xs leading-5">
                    <p>{card.source_text}</p>
                    {(card.sharing_impact?.active_recipient_count || 0) > 0 ? (
                      <p className="mt-1 font-medium text-destructive">
                        This may change information shared with {plural(card.sharing_impact!.active_recipient_count, "person", "people")}.
                      </p>
                    ) : null}
                  </li>
                ))}
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
          {onConfirmNeedsOwner && pendingCards.length === receipt.needsOwner ? (
            <Button size="standard" onClick={() => void confirm()} isLoading={confirming} disabled={confirming}>
              {`Save ${receipt.needsOwner === 1 ? "it" : `these ${receipt.needsOwner}`} too`}
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
