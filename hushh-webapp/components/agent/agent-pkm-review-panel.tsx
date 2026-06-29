"use client";

import { Brain, Check, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { cn } from "@/lib/utils";

type AgentPkmReviewPanelProps = {
  cards: AgentPkmPreviewCard[];
  saving?: boolean;
  className?: string;
  onSave: () => void;
  onDismiss: () => void;
};

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

export function AgentPkmReviewPanel({
  cards,
  saving = false,
  className,
  onSave,
  onDismiss,
}: AgentPkmReviewPanelProps) {
  if (cards.length === 0) return null;

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
            <p className="font-medium text-foreground">Save to PKM?</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Agent found durable context that needs your review before it is stored.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
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
            disabled={saving}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {cards.slice(0, 3).map((card) => (
          <div key={card.card_id} className="rounded-md border border-border/60 bg-background p-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-md bg-muted px-2 py-1 font-medium text-foreground">
                {titleize(cardDomain(card))}
              </span>
              {card.intent_class ? (
                <span className="text-muted-foreground">{titleize(card.intent_class)}</span>
              ) : null}
            </div>
            {cleanText(card.source_text) ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {cleanText(card.source_text)}
              </p>
            ) : null}
            {card.confirmation_reason ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {cleanText(card.confirmation_reason, 160)}
              </p>
            ) : null}
          </div>
        ))}
        {cards.length > 3 ? (
          <p className="text-xs text-muted-foreground">
            +{cards.length - 3} more PKM candidate{cards.length - 3 === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
