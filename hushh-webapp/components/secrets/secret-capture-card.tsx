"use client";

import { SECRET_KIND_LABELS, SecretItemsPanel, type SecretPanelItem } from "@/components/secrets/secret-items-panel";
import { useSecretReveal } from "@/components/secrets/use-secret-reveal";
import type { SecretFileTo, SecretKind } from "@/lib/pkm/secret-patterns";
import { secretOfferFor, type SecretOffer } from "@/lib/pkm/secret-span-guard";

/** What the chat knows about a kept secret: its id and label, never its value. */
export type KeptSecretRef = {
  id: string;
  label: string;
  kind: SecretKind;
  fileTo: SecretFileTo;
  offerNoun: string | null;
};

export function keptSecretPanelItems(items: readonly KeptSecretRef[]): SecretPanelItem[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    return [{
      id: item.id,
      label: item.label,
      kindLabel: SECRET_KIND_LABELS[item.kind] ?? "Secret",
      offer: secretOfferFor(item),
      filedLabel: null,
    }];
  });
}

/**
 * The chat card for secrets the device guard just kept: what was saved, a
 * reveal after unlock, and an offer to file a card or an ID number where it
 * belongs. The model never saw any of it; One only knows the labels.
 */
export function SecretCaptureCard({
  items,
  onUnlock,
  onOffer,
}: {
  items: readonly KeptSecretRef[];
  onUnlock: () => void;
  onOffer: (secretId: string, offer: SecretOffer) => void;
}) {
  const { locked, revealed, busyId, reveal, hide } = useSecretReveal();
  const panelItems = keptSecretPanelItems(items);
  return (
    <SecretItemsPanel
      testId="secret-capture-card"
      title={panelItems.length === 1 ? "Kept in Secrets" : `${panelItems.length} kept in Secrets`}
      description="One knows these only by name. Values stay encrypted in your vault and open only here."
      items={panelItems}
      revealed={revealed}
      locked={locked}
      busyId={busyId}
      onReveal={(id) => void reveal(id)}
      onHide={hide}
      onUnlock={onUnlock}
      onOffer={(item) => (item.offer ? onOffer(item.id, item.offer) : undefined)}
    />
  );
}
