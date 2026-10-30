"use client";

import type { ComponentType } from "react";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import {
  ProfileInnerProgressIcon,
  ProfileInnerSuccessIcon,
  ProfileInnerWarningIcon,
} from "@/components/profile/profile-inner-icons";
import { ProfilePanePauseIcon } from "@/components/profile/profile-pane-icons";
import { ProfileSecondaryReceiptIcon } from "@/components/profile/profile-secondary-icons";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";

/** How a packet reads at a glance. It picks the row's icon, the way a Payouts activity kind does. */
export type PacketTone = "ready" | "listed" | "waiting" | "attention" | "paused";

export const PACKET_TONE_ICONS: Record<PacketTone, ComponentType<object>> = {
  ready: ProfileSecondaryReceiptIcon,
  listed: ProfileInnerSuccessIcon,
  waiting: ProfileInnerProgressIcon,
  attention: ProfileInnerWarningIcon,
  paused: ProfilePanePauseIcon,
};

/**
 * One packet in a history-style list, shared by the owner's Packets list and
 * a buyer's view of someone's profile.
 */
export type PacketRowItem = {
  /** Stable key, e.g. the packet id. */
  id: string;
  /** The packet's name. */
  title: string;
  /** One plain line: "Ready to list · 3 documents · Jan–Jun 2026". */
  statusLine: string;
  /** Price on the trailing side; null shows none. */
  amountCents: number | null;
  tone: PacketTone;
  /** Replaces the tone's icon, e.g. for a request row. */
  icon?: ComponentType<object>;
  /** Opens the packet's page. Without it the row only reads. */
  onOpen?: () => void;
};

/**
 * CONTRACT: a Payouts activity row for packets. Icon, name, one status line
 * and price; the whole row opens the packet's page. Rows never hold buttons
 * of their own: every action lives on the page.
 */
export function PacketRow({ item }: { item: PacketRowItem }) {
  return (
    <SettingsRow icon={item.icon ?? PACKET_TONE_ICONS[item.tone]} iconTone="capability" title={item.title}
      description={item.statusLine} textOverflow="truncate" chevron={Boolean(item.onOpen)} onClick={item.onOpen}
      trailing={item.amountCents === null ? undefined
        : <span className="tabular-nums">{formatDocumentRequestPrice(item.amountCents)}</span>} />
  );
}

/** Packet rows for a SettingsGroup, like PayoutActivityRows. */
export function PacketRows({ items }: { items: readonly PacketRowItem[] }) {
  return <>{items.map((item) => <PacketRow key={item.id} item={item} />)}</>;
}
