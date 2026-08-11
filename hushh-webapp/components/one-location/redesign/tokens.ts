/**
 * One Location redesign tokens.
 *
 * The Location redesign was the reference implementation for the app-wide
 * surface grammar; its tokens were PROMOTED to lib/morphy-ux/tokens/surfaces
 * so every feature composes the same system. This module re-exports them to
 * keep existing imports stable. Accent usage flows through the
 * --app-accent-* family (iOS Blue default, Molten Gold opt-in), never a
 * hardcoded hex.
 */

export {
  ACCENT_HOVER_BORDER,
  ACCENT_ICON_BUBBLE,
  ACCENT_TEXT,
  AVATAR_BUBBLE,
  CARD_SURFACE,
  EYEBROW,
  MUTED_TEXT,
  PILL_LIVE,
  PILL_NEUTRAL,
  PILL_PENDING,
  PILL_READY,
  SCREEN_TITLE,
  SECTION_HEADING,
  SECTION_TITLE,
  SUBCARD_SURFACE,
  TRUST_SURFACE,
  WARNING_SURFACE,
} from "@/lib/morphy-ux/tokens/surfaces";
