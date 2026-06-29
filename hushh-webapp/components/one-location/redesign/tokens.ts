/**
 * Shared visual tokens for the One Location redesign (Figma: one_location_final_fixed_clean_navigation).
 *
 * PRESENTATION ONLY. These className constants reuse the EXACT app-wide design
 * system so the Location screens look identical to other pages (profile, kai,
 * one/*):
 * - Surfaces use the same `--app-card-*` tokens as SurfaceCard.
 * - Titles use `font-semibold` + the semantic Tailwind size scale (mapped to the
 *   Apple-HIG `--foundation-*` tokens) — the same way SurfaceCardTitle renders,
 *   NOT a separate display font.
 * No business logic lives here.
 */

/** Standard rounded card surface — matches SurfaceCard (app-card tokens). */
export const CARD_SURFACE =
  "rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]";

/** Soft inset surface used for sub-cards / list rows inside a card. */
export const SUBCARD_SURFACE =
  "rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]";

/** Section heading (e.g. "Trusted Circle", "Device readiness"). */
export const SECTION_HEADING =
  "text-lg font-semibold leading-tight tracking-tight text-foreground";

/** Primary screen title (header). */
export const SCREEN_TITLE =
  "text-2xl font-semibold leading-tight tracking-tight text-foreground";

/** Muted secondary copy. */
export const MUTED_TEXT = "text-sm leading-snug text-muted-foreground";

/** Foundation gold deep — primary accent (replaces the old Apple system blue).
 *  Matches --foundation-gold-deep / text-accent-strong used app-wide. */
export const ACCENT_BLUE = "#b8894d";

/** Status pill palettes. */
export const PILL_READY =
  "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
export const PILL_PENDING =
  "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300";
export const PILL_LIVE =
  "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200";
export const PILL_NEUTRAL =
  "border-border/70 bg-muted/60 text-muted-foreground";

/** Small uppercase eyebrow label. */
export const EYEBROW =
  "text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground";

/** Warning / caution banner surface. */
export const WARNING_SURFACE =
  "rounded-[var(--app-card-radius-compact,16px)] border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200";

/** Trust note banner surface (reassuring, neutral). */
export const TRUST_SURFACE =
  "rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]";

/** Avatar bubble base. */
export const AVATAR_BUBBLE =
  "flex shrink-0 items-center justify-center rounded-full bg-[color:var(--app-card-surface-muted,#e5e5ea)] text-sm font-semibold text-foreground dark:bg-white/[0.08]";
