/**
 * Design tokens for the One KYC review screen.
 *
 * PRESENTATION ONLY. Consumes the switchable app accent (the `--app-accent-*`
 * family in app/globals.css) — never raw accent hex — so the KYC screen follows
 * the accent preference (iOS Blue default, Molten Gold under
 * html[data-accent="gold"]), exactly like the One Location redesign. Card
 * surfaces reuse the shared `--app-card-*` tokens. No business logic lives here.
 */

/** Standard rounded card surface — matches SurfaceCard (app-card tokens). */
export const CARD_SURFACE =
  "rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]";

/** Soft inset surface for sub-cards / list rows inside a card. */
export const SUBCARD_SURFACE =
  "rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]";

/** Shared readable section label. */
export const EYEBROW =
  "font-[family-name:var(--font-app-body)] text-[15px] font-medium leading-[20px] tracking-[-0.01em] text-[#6E6E73]";

/** Shared readable accent section label. */
export const EYEBROW_ACCENT =
  "font-[family-name:var(--font-app-body)] text-[15px] font-medium leading-[20px] tracking-[-0.01em] text-[#6E6E73]";

/**
 * Primary pill CTA (compact). Solid accent pill, accent-foreground label. Meets
 * the 44px touch target and shows a visible accent focus ring.
 */
export const BTN_PRIMARY =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] px-5 py-2.5 text-sm font-semibold text-[color:var(--app-accent-fg)] transition-colors hover:bg-[color:var(--app-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40 disabled:pointer-events-none";

/**
 * Primary full-width prominent CTA — the single main action per screen
 * (e.g. Confirm, Send). Carries a soft accent elevation shadow.
 */
export const BTN_PRIMARY_LG =
  "flex w-full min-h-[44px] items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] py-3.5 text-[17px] font-semibold text-[color:var(--app-accent-fg)] shadow-[0_4px_14px_var(--app-accent-border)] transition-colors hover:bg-[color:var(--app-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none";

/**
 * Neutral outline pill — secondary and destructive actions (Deny, Reject).
 * Visually subordinate to the accent primary (Apple HIG: one primary CTA/screen).
 */
export const BTN_OUTLINE =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-border bg-transparent px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40 disabled:pointer-events-none";

/** Text / link action (Cancel, Change, inline actions). */
export const BTN_TEXT =
  "inline-flex items-center gap-1 rounded-md text-[15px] font-medium text-[color:var(--app-accent)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-40 disabled:pointer-events-none";

/** Rounded icon chip — accent glyph on a tinted accent surface. */
export const ICON_CHIP =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]";

/** Circular selection control (checkbox) — base + on/off states. */
export const SELECT_CIRCLE_BASE =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors";
export const SELECT_CIRCLE_ON =
  "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]";
export const SELECT_CIRCLE_OFF = "border-border bg-transparent";

/** Status pill palettes (kept from the shared design system for parity). */
export const PILL_READY =
  "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
export const PILL_PENDING =
  "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300";
export const PILL_NEUTRAL =
  "border-border/70 bg-muted/60 text-muted-foreground";
