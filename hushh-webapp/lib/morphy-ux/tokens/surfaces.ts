/**
 * Morphy UX surface + typography tokens.
 *
 * Promoted from the One Location redesign (the reference implementation for
 * app-surface polish) so every feature can compose the same card grammar.
 *
 * PRESENTATION ONLY. These className constants reuse the app-wide design
 * system exactly:
 * - Surfaces use the `--app-card-*` tokens (same as SurfaceCard).
 * - Accent usage flows through the `--app-accent-*` family, which resolves to
 *   iOS Blue by default and Molten Gold under html[data-accent="gold"]. Never
 *   hardcode an accent hex here.
 * - Titles use `font-semibold` + the semantic Tailwind size scale (mapped to
 *   the Apple-HIG `--foundation-*` tokens), the same way SurfaceCardTitle
 *   renders, NOT a separate display font.
 * No business logic lives here.
 */

/** Standard rounded card surface — matches SurfaceCard (app-card tokens). */
export const CARD_SURFACE =
  "rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]";

/** Soft inset surface used for sub-cards / list rows inside a card. */
export const SUBCARD_SURFACE =
  "rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]";

/** Section heading (e.g. "Trusted Circle", "Device readiness"). */
export const SECTION_HEADING = "ui-text-section-label";

/** Primary screen title (header). */
export const SCREEN_TITLE = "ui-text-page-title";

/** Muted secondary copy. */
export const MUTED_TEXT = "ui-text-row-description";

/**
 * Accent utility classes. These follow the active accent preference
 * (iOS Blue default, Molten Gold opt-in) via the --app-accent family.
 */
export const ACCENT_TEXT = "text-[color:var(--app-accent)]";
export const ACCENT_ICON_BUBBLE =
  "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]";
export const ACCENT_HOVER_BORDER =
  "hover:border-[color:var(--app-accent-ring)]";

/** Status pill palettes. */
export const PILL_READY =
  "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
export const PILL_PENDING =
  "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300";
export const PILL_LIVE =
  "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200";
export const PILL_NEUTRAL =
  "border-border/70 bg-muted/60 text-muted-foreground";

/** Shared readable section label. */
export const EYEBROW = "ui-text-section-label";

/** Warning / caution banner surface. */
export const WARNING_SURFACE =
  "rounded-[var(--app-card-radius-compact,16px)] border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200";

/** Trust note banner surface (reassuring, neutral). */
export const TRUST_SURFACE =
  "rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]";

/** Avatar bubble base. */
export const AVATAR_BUBBLE =
  "flex shrink-0 items-center justify-center rounded-full bg-[color:var(--app-card-surface-muted,#e5e5ea)] text-sm font-semibold text-foreground dark:bg-white/[0.08]";
