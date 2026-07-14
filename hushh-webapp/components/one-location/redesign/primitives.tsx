"use client";

/**
 * One Location redesign primitives.
 *
 * The Location redesign was the reference implementation for the app-wide
 * surface grammar; its shared primitives were PROMOTED to
 * lib/morphy-ux/ui/surface-primitives so every feature composes the same
 * system. This module re-exports them to keep existing imports stable.
 * Only LocationHeader stays feature-local.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { MUTED_TEXT, SCREEN_TITLE } from "@/lib/morphy-ux/tokens/surfaces";

export {
  AvatarBubble as Avatar,
  EmptyState,
  PrivacyStatusCard,
  QuickPathRow,
  SectionCard,
  StatusPill,
  TaskFlowHeader,
  TrustNoteCard,
  WarningCard,
} from "@/lib/morphy-ux/ui/surface-primitives";

export function LocationHeader({
  title,
  subtitle,
  trailing,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className={SCREEN_TITLE}>{title}</h1>
        {subtitle ? <p className={cn(MUTED_TEXT, "mt-1")}>{subtitle}</p> : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </header>
  );
}
