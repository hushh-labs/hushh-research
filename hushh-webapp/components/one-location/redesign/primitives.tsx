"use client";

/**
 * One Location redesign primitives.
 *
 * The Location redesign was the reference implementation for the app-wide
 * surface grammar; its shared primitives were PROMOTED to
 * lib/morphy-ux/ui/surface-primitives so every feature composes the same
 * system. This module re-exports them to keep existing imports stable.
 * All route chrome uses the app-wide PageHeader; this module retains only
 * location-specific body primitives and compatibility re-exports.
 */

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
