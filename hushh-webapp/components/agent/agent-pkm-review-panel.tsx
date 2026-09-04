"use client";

import { Brain, Check, Loader2, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  isReservedPkmCard,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { cn } from "@/lib/utils";

type AgentPkmReviewPanelProps = {
  cards: AgentPkmPreviewCard[];
  saving?: boolean;
  className?: string;
  /** Card ids the owner has kept selected; undefined means every reviewable card. */
  selectedCardIds?: ReadonlySet<string>;
  onToggleCard?: (cardId: string, selected: boolean) => void;
  onToggleGroup?: (cardIds: string[], selected: boolean) => void;
  onSave: () => void;
  onDismiss: () => void;
  onEdit?: () => void;
};

type ReviewGroup = { domain: string; scope: string | null; cards: AgentPkmPreviewCard[] };

/** Group cards by destination so a long paste reads as a table of contents, not a list. */
function groupReviewCards(cards: AgentPkmPreviewCard[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const card of cards) {
    const domain = cardDomain(card);
    const scope = cardScope(card);
    const key = `${domain}::${scope || ""}`;
    const group = groups.get(key) || { domain, scope, cards: [] };
    group.cards.push(card);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function cleanText(value: unknown, maxLength = 120): string {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function titleize(value: string | null | undefined): string {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function cardDomain(card: AgentPkmPreviewCard): string {
  const structureDecision =
    card.structure_decision && typeof card.structure_decision === "object"
      ? card.structure_decision
      : {};
  return (
    String(card.manifest_draft?.domain || "").trim() ||
    String(structureDecision.target_domain || "").trim() ||
    String(card.target_domain || "").trim() ||
    "PKM"
  );
}

function cardScope(card: AgentPkmPreviewCard): string | null {
  const scope = String(card.primary_json_path || card.target_entity_scope || "").trim();
  if (!scope) return null;
  return scope
    .split(".")
    .map((segment) => titleize(segment))
    .filter(Boolean)
    .join(" > ");
}

function cardSensitivity(card: AgentPkmPreviewCard): string {
  const decision = card.structure_decision && typeof card.structure_decision === "object"
    ? card.structure_decision
    : {};
  const labels = decision.sensitivity_labels && typeof decision.sensitivity_labels === "object"
    ? decision.sensitivity_labels as Record<string, unknown>
    : {};
  const path = String(card.primary_json_path || card.target_entity_scope || "").trim();
  return titleize(String(labels[path] || labels[path.split(".")[0] || ""] || "confidential"));
}

export function AgentPkmReviewPanel({
  cards,
  saving = false,
  className,
  selectedCardIds,
  onToggleCard,
  onToggleGroup,
  onSave,
  onDismiss,
  onEdit,
}: AgentPkmReviewPanelProps) {
  const reviewableCards = cards.filter((card) => !isReservedPkmCard(card));
  if (reviewableCards.length === 0) return null;
  const isSelected = (card: AgentPkmPreviewCard) =>
    selectedCardIds ? selectedCardIds.has(card.card_id) : true;
  const selectedCount = reviewableCards.filter(isSelected).length;
  const selectable = Boolean(onToggleCard);
  const groups = groupReviewCards(reviewableCards);
  const multiGroup = groups.length > 1;

  return (
    <div
      className={cn(
        "rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm",
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2">
          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <Brain className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-foreground">Save this memory?</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              One needs your review before this is stored.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {onEdit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={onEdit}
              disabled={saving}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            onClick={onDismiss}
            disabled={saving}
          >
            <X className="h-3.5 w-3.5" />
            Skip
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-2"
            onClick={onSave}
            disabled={saving || selectedCount === 0}
            data-testid="agent-pkm-review-save"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {selectable && selectedCount !== reviewableCards.length
              ? `Save ${selectedCount} of ${reviewableCards.length}`
              : `Save all ${reviewableCards.length}`}
          </Button>
        </div>
      </div>

      <div className="mt-3 max-h-96 space-y-3 overflow-y-auto rounded-md border border-border/60 bg-background p-2 pr-1" data-testid="agent-pkm-review-list">
        {groups.map((group) => {
          const groupIds = group.cards.map((card) => card.card_id);
          const groupSelected = group.cards.filter(isSelected).length;
          const groupKey = `${group.domain}::${group.scope || ""}`;
          return (
            <section key={groupKey} className="space-y-1.5" data-testid="agent-pkm-review-group">
              {multiGroup ? (
                <div className="flex items-center justify-between gap-2 px-1">
                  <p className="text-xs font-semibold text-foreground">
                    {titleize(group.domain)}{group.scope ? ` › ${group.scope}` : ""}
                    <span className="ml-2 tabular-nums text-muted-foreground">
                      {selectable ? `${groupSelected}/${group.cards.length}` : group.cards.length}
                    </span>
                  </p>
                  {selectable && onToggleGroup ? (
                    <button
                      type="button"
                      className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
                      onClick={() => onToggleGroup(groupIds, groupSelected !== group.cards.length)}
                      disabled={saving}
                    >
                      {groupSelected === group.cards.length ? "Skip group" : "Keep group"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {group.cards.map((card) => {
                const selected = isSelected(card);
                return (
                  <label
                    key={card.card_id}
                    className={cn(
                      "flex gap-2 rounded-lg px-3 py-2.5 text-xs",
                      selected ? "bg-muted/35" : "bg-muted/15 opacity-70",
                    )}
                    data-testid="agent-pkm-review-card"
                    data-selected={selected ? "true" : "false"}
                  >
                    {selectable ? (
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--app-accent)]"
                        checked={selected}
                        disabled={saving}
                        onChange={(event) => onToggleCard?.(card.card_id, event.target.checked)}
                        aria-label={`Keep: ${cleanText(card.source_text, 80) || titleize(cardDomain(card))}`}
                      />
                    ) : null}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-medium text-foreground">
                          {multiGroup ? cleanText(card.source_text, 140) || titleize(cardDomain(card)) : `${titleize(cardDomain(card))}${cardScope(card) ? ` · ${cardScope(card)}` : ""}`}
                        </p>
                        <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {cardSensitivity(card)}
                        </span>
                      </div>
                      {multiGroup ? null : card.confirmation_reason ? (
                        <p className="leading-5 text-muted-foreground">{cleanText(card.confirmation_reason, 120)}</p>
                      ) : null}
                      {(card.validation_hints || []).includes("possible_duplicate") ? (
                        <p className="leading-5 text-muted-foreground">Looks similar to something already in Memory.</p>
                      ) : null}
                      {card.sharing_impact?.active_recipient_count ? (
                        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 leading-5 text-foreground">
                          {cleanText(card.sharing_impact.summary, 160)}
                        </p>
                      ) : multiGroup ? null : (
                        <p className="leading-5 text-muted-foreground">Private to your private agent. Consent required to share.</p>
                      )}
                    </div>
                  </label>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
