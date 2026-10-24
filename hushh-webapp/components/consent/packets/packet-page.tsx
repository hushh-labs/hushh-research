"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import {
  AdaptiveDetailSurface,
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import accountStyles from "@/components/profile/profile-your-account.module.css";
import { Button } from "@/lib/morphy-ux/button";

import { PACKET_TONE_ICONS, type PacketTone } from "./packet-rows";

/** A fact on a packet's page, read like a Payouts receipt row. */
export type PacketPageRow = {
  id: string;
  title: string;
  description?: string;
  /** Trailing value, e.g. "$12.34". */
  value?: string;
  /** Shows the tone's icon. */
  tone?: PacketTone;
  onOpen?: () => void;
};

export type PacketPageSection = {
  id: string;
  /** "What’s inside", "What buyers see", "Price", "Status". */
  title: string;
  rows?: readonly PacketPageRow[];
  /** Content under the rows, e.g. a price field. */
  children?: ReactNode;
};

export type PacketPageAction = {
  id: string;
  /** Says what happens: "List for $12.34", "Buy for $12.34". */
  label: string;
  /** primary (default): the page's main step; secondary: the alternative; plain: a light step. */
  emphasis?: "primary" | "secondary" | "plain";
  disabled?: boolean;
  /** For an action that shows or hides part of the page. */
  expanded?: boolean;
} & (
  | { onSelect: () => void; href?: never }
  /** Goes somewhere instead, e.g. "View request": a link, not a button. */
  | { href: string; onSelect?: never }
);

export type PacketPageProps = {
  open: boolean;
  /** Back and Close call it with false; the list stays where it was. */
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One plain line under the title, e.g. the row's status line. */
  description?: string;
  sections: readonly PacketPageSection[];
  /** At most three, most important first. None renders no buttons. */
  actions?: readonly PacketPageAction[];
  /** The result of the last action, announced politely. */
  message?: string;
};

function ActionButton({ action }: { action: PacketPageAction }) {
  const emphasis = action.emphasis ?? "primary";
  const look = { size: emphasis === "plain" ? "standard" : "prominent", variant: emphasis === "primary" ? "blue" : "none",
    effect: emphasis === "plain" ? "fade" : "fill" } as const;
  if (action.href !== undefined) return <Button asChild {...look}><Link href={action.href}>{action.label}</Link></Button>;
  return (
    <Button type="button" {...look} disabled={action.disabled} aria-expanded={action.expanded} onClick={action.onSelect}>
      {action.label}
    </Button>
  );
}

/**
 * CONTRACT: one packet's own page, opened from its row the way a Payouts
 * activity opens its receipt: a local sheet, never a route. Back closes it
 * and the list stays where it was. Owner and buyer pages differ only in the
 * sections and actions they pass; actions live here, never on the rows.
 */
export function PacketPage({ open, onOpenChange, title, description, sections, actions = [], message }: PacketPageProps) {
  const [primary, secondary, tertiary] = actions;
  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
      surfaceClassName={`${accountStyles.walletContent} consent-presentation-surface`}
    >
      <SettingsPresentationProvider density="compact" separatorInset>
        {sections.map((section) => (
          <SettingsGroup key={section.id} title={section.title}>
            {section.rows?.map((row) => (
              <SettingsRow key={row.id} icon={row.tone ? PACKET_TONE_ICONS[row.tone] : undefined} iconTone="capability"
                title={row.title} description={row.description} chevron={!!row.onOpen} onClick={row.onOpen}
                trailing={row.value ? <span className="tabular-nums">{row.value}</span> : undefined} />
            ))}
            {section.children}
          </SettingsGroup>
        ))}
        {message ? <HelperText role="status" className="px-1 pt-3">{message}</HelperText> : null}
        {primary ? (
          <FlowActionGroup stacked className="pt-4" primary={<ActionButton action={primary} />}
            secondary={secondary ? <ActionButton action={secondary} /> : undefined}
            tertiary={tertiary ? <ActionButton action={tertiary} /> : undefined} />
        ) : null}
      </SettingsPresentationProvider>
    </AdaptiveDetailSurface>
  );
}
