"use client";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { pkmMemoryRowLabels, type PkmMemoryCard } from "@/lib/pkm/pkm-memory-cards";

/**
 * One memory as an iOS-style navigation row: a short name, the readable value
 * beneath it, and a chevron. Used by Recently learned, category browsing, and
 * search results so those three surfaces never drift apart.
 *
 * Deliberately carries no metadata (source, timestamp, sharing state) and no
 * inline edit/forget controls — those live in the memory detail view. When a
 * `breadcrumb` is passed (deep search results), it replaces the value subtitle
 * so the row orients the hit inside the nested structure, e.g.
 * `Financial › Goals › Retirement`.
 */
export function PkmMemoryRow({
  card,
  onOpen,
  testId,
  breadcrumb,
}: {
  card: PkmMemoryCard;
  onOpen: (card: PkmMemoryCard) => void;
  testId?: string;
  breadcrumb?: string;
}) {
  const { primary, secondary } = pkmMemoryRowLabels(card);
  return (
    <SettingsRow
      title={primary}
      description={breadcrumb || secondary || undefined}
      onClick={() => onOpen(card)}
      chevron
      ariaLabel={`Open memory: ${primary}`}
      testId={testId ?? `memory-row-${card.id}`}
    />
  );
}
