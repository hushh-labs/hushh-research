"use client";

import type { ComponentType } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  FinanceAgentIcon,
  GmailAgentIcon,
  KycAgentIcon,
  LocationAgentIcon,
  MemoryAgentIcon,
  PreferencesProfileIcon,
  RiaAgentIcon,
  WalletAgentIcon,
} from "@/components/icons";
import type { ReservedOfferItem } from "@/lib/pkm/reserved-offer";

/**
 * The owning app's registry glyph: the same bare duotone mark the app wears on
 * /one, on a transparent well (`iconTone="capability"`), never a tile.
 */
const OWNER_GLYPH: Readonly<Record<string, ComponentType<Record<string, unknown>>>> = {
  finance: FinanceAgentIcon,
  ria: RiaAgentIcon,
  location: LocationAgentIcon,
  kyc: KycAgentIcon,
  settings: PreferencesProfileIcon,
  wallet: WalletAgentIcon,
  gmail_receipts: GmailAgentIcon,
};

export function reservedOwnerGlyph(ownerFeature: string): ComponentType<Record<string, unknown>> {
  return OWNER_GLYPH[ownerFeature] ?? MemoryAgentIcon;
}

// Matches the save card's inset: a 12 px hairline-bordered flat surface.
const INSET_GROUP = "[--settings-group-radius:12px] border border-[color:var(--app-card-border-standard)] shadow-none";

/**
 * Offers to commit a fact on the screen that owns it ("Add as Home in
 * Location"). Each row is the shared settings row: flat Morphy surface, the
 * Material press ripple, 56 px or taller, chevron, and the whole label, which
 * wraps rather than hide the app it names.
 */
export function ReservedOfferRows({
  offers,
  onOpen,
  testId = "reserved-offer-rows",
}: {
  offers: readonly ReservedOfferItem[];
  onOpen: (offer: ReservedOfferItem) => void;
  testId?: string;
}) {
  if (!offers.length) return null;
  return (
    <SettingsGroup embedded separatorInset density="compact" shellClassName={INSET_GROUP} testId={testId}>
      {offers.map((offer) => (
        <SettingsRow
          key={offer.id}
          icon={reservedOwnerGlyph(offer.ownerFeature)}
          iconTone="capability"
          density="compact"
          title={offer.label}
          // Never truncated: the end of the label names the app it opens.
          textOverflow="wrap"
          chevron
          onClick={() => onOpen(offer)}
          testId="reserved-offer-row"
        />
      ))}
    </SettingsGroup>
  );
}
