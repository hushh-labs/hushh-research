/**
 * RIA sub-agent — Apple-clean status tones.
 *
 * Central mapping so every RIA surface (home, clients, workspace, request /
 * account detail) reads the same premium palette. Green is reserved for genuine
 * SUCCESS (verified / connected / active); pending/attention is GOLD (the RIA
 * accent); critical stays a functional red; everything else is calm greige.
 *
 * All values resolve from the --ria-* / --foundation-* namespace, so they only
 * render the premium palette inside body[data-persona-surface="ria"].
 */

export type RiaTone = "success" | "attention" | "critical" | "neutral";

/** Badge / chip treatment (border + tinted fill + text). */
export const RIA_TONE_BADGE: Record<RiaTone, string> = {
  success:
    "border-[color:var(--ria-success-border)] bg-[color:var(--ria-success-bg)] text-[color:var(--ria-success-text)]",
  attention:
    "border-[color:var(--foundation-accent-border)] bg-[color:var(--foundation-accent-surface)] text-[color:var(--ria-gold)]",
  critical:
    "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
  neutral:
    "border-[color:var(--ria-divider-outer)] bg-[color:rgba(107,114,128,0.1)] text-[color:var(--ria-alt)]",
};

/** Softer surface treatment for hero / container cards (border + faint fill). */
export const RIA_TONE_SURFACE: Record<RiaTone, string> = {
  success:
    "border-[color:var(--ria-success-border)] bg-[color:var(--ria-success-bg)]",
  attention:
    "border-[color:var(--foundation-accent-border)] bg-[color:var(--foundation-accent-surface)]",
  critical: "border-red-500/20 bg-red-500/[0.08]",
  neutral: "border-[color:var(--ria-divider-outer)] bg-white",
};
