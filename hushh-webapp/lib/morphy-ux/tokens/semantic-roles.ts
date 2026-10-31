/**
 * Semantic role layer.
 *
 * The single place that decides which MEANING gets which colour treatment.
 * Components should name the meaning ("this row is a pending request") and
 * let this module choose the classes, instead of picking a colour at the
 * call site. That is what keeps one status from rendering three different
 * washes on three different screens.
 *
 * PRESENTATION ONLY — no React, no state, no data access, no imports from
 * feature code. Every class string below resolves through the CSS custom
 * properties in app/globals.css, so the layer carries no colour literals of
 * its own and follows theme (and, for `action`, the accent preference)
 * automatically.
 *
 * Colour is never the only signal. These classes tint a glyph, a tile or a
 * hairline; the icon, label, count, check, switch position and state copy
 * that sit alongside them must stay exactly as they are.
 */

/**
 * The closed set of meanings a surface may express.
 *
 * - `action`  something the user can DO: a primary CTA, navigation, share,
 *             create, add, request, or a location/map affordance. This is
 *             the only role that follows the user's accent preference.
 * - `success` a settled positive FACT: active, enabled, verified, accepted,
 *             checked in. A status, never a call to action.
 * - `danger`  emergency, destructive or failed: SOS, delete, revoke, stop.
 *             Reserved for real consequence — "off" is not danger.
 * - `warning` needs a look soon: pending, awaiting review, expiring.
 * - `people`  humans and their groupings: circles, trusted contacts,
 *             private sharing.
 * - `neutral` no state to report: settings, empty, zero, off, unavailable,
 *             and every utility glyph (chevrons, disclosure arrows,
 *             separators). The default, and the majority of any screen.
 */
export type SemanticRole =
  | "action"
  | "success"
  | "danger"
  | "warning"
  | "people"
  | "neutral";

/** Every role, for exhaustive iteration (pickers, tests, storybooks). */
export const SEMANTIC_ROLES: readonly SemanticRole[] = Object.freeze([
  "action",
  "success",
  "danger",
  "warning",
  "people",
  "neutral",
] as const);

/**
 * The three slots a role can paint.
 *
 * - `glyph`  the icon or symbol itself. Body and label copy are NOT in
 *            scope: text keeps its own hierarchy colour.
 * - `tile`   the quiet wash behind that glyph — an icon bubble or a
 *            compact pill, not a full-card fill.
 * - `border` the hairline that pairs with `tile`.
 *
 * `glyph` resolves to the role's `-deep` / `-bright` pair, never to the
 * flat role token. The flat token is a FILL tone: --app-success is
 * 2.22:1 on white and 2.04:1 on its own tint, under even the 3:1
 * non-text floor, so a glyph painted with it disappears. The `-deep`
 * (light) and `-bright` (dark) partners are the legible tones, and the
 * light/dark pairing is the same one --app-accent-deep /
 * --app-accent-bright has used across the app all along.
 */
export interface SemanticRoleClasses {
  readonly glyph: string;
  readonly tile: string;
  readonly border: string;
}

const defineRole = (
  glyph: string,
  tile: string,
  border: string,
): SemanticRoleClasses => Object.freeze({ glyph, tile, border });

/**
 * Role → class strings. Frozen: a role's rendering is a system decision, so
 * call sites compose these, they do not mutate or extend them.
 *
 * Each role draws from one token family only. Mixing families inside a
 * single row is what produces the rainbow effect this layer exists to stop:
 * at most one strong role per row or compact card.
 */
export const SEMANTIC_ROLE_CLASSES: Readonly<
  Record<SemanticRole, SemanticRoleClasses>
> = Object.freeze({
  // Follows the accent preference by design — the only role that does.
  action: defineRole(
    "text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]",
    "bg-[color:var(--app-accent-tint)]",
    "border-[color:var(--app-accent-border)]",
  ),
  success: defineRole(
    "text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]",
    "bg-[color:var(--app-success-tint)]",
    "border-[color:var(--app-success-border)]",
  ),
  danger: defineRole(
    "text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]",
    "bg-[color:var(--app-destructive-tint)]",
    "border-[color:var(--app-destructive-border)]",
  ),
  warning: defineRole(
    "text-[color:var(--app-warning-deep)] dark:text-[color:var(--app-warning-bright)]",
    "bg-[color:var(--app-warning-tint)]",
    "border-[color:var(--app-warning-border)]",
  ),
  people: defineRole(
    "text-[color:var(--app-people-deep)] dark:text-[color:var(--app-people-bright)]",
    "bg-[color:var(--app-people-tint)]",
    "border-[color:var(--app-people-border)]",
  ),
  // The resting state. Reads as "nothing to report", not as a colour.
  neutral: defineRole(
    "text-[color:var(--app-secondary-label)]",
    "bg-[color:var(--app-neutral-fill)]",
    "border-[color:var(--app-separator)]",
  ),
});

/**
 * The stronger fill and its readable foreground, for the rare surface that
 * is genuinely solid — a destructive confirm button, a live SOS banner.
 *
 * `fg` is the tone that sits ON the solid colour. It is NOT the tone to use
 * on a `tile` wash: there, the readable tone is the role's `glyph` class.
 * Reach for this only when a wash genuinely cannot carry the meaning;
 * a solid fill is loud by definition.
 */
export interface SemanticRoleSolid {
  readonly fill: string;
  readonly fg: string;
}

const defineSolid = (fill: string, fg: string): SemanticRoleSolid =>
  Object.freeze({ fill, fg });

export const SEMANTIC_ROLE_SOLID: Readonly<
  Record<SemanticRole, SemanticRoleSolid>
> = Object.freeze({
  action: defineSolid(
    "bg-[color:var(--app-accent)]",
    "text-[color:var(--app-accent-fg)]",
  ),
  success: defineSolid(
    "bg-[color:var(--app-success)]",
    "text-[color:var(--app-success-fg)]",
  ),
  danger: defineSolid(
    "bg-[color:var(--app-destructive)]",
    "text-[color:var(--app-destructive-fg)]",
  ),
  warning: defineSolid(
    "bg-[color:var(--app-warning)]",
    "text-[color:var(--app-warning-fg)]",
  ),
  people: defineSolid(
    "bg-[color:var(--app-people)]",
    "text-[color:var(--app-people-fg)]",
  ),
  neutral: defineSolid(
    "bg-[color:var(--app-neutral-fill-strong)]",
    "text-[color:var(--app-secondary-label)]",
  ),
});

/** Conditions under which a role loses its colour. */
export interface ResolveRoleOptions {
  /**
   * The thing exists but currently reports nothing: a zero count, an off
   * switch, an unavailable or disabled control, an empty list.
   */
  readonly inactive?: boolean;
}

/**
 * STATE BEATS CATEGORY.
 *
 * A category earns its colour only while it has something to say. "Trusted
 * circle" is `people`, but a circle with zero members is `neutral`; SMS
 * safety is `danger`, but switched off it is `neutral`. Colour marks live
 * state, not the topic of the row.
 *
 * Note that inactive is not failure: an off control is grey, never red.
 */
export function resolveRole(
  role: SemanticRole,
  opts?: ResolveRoleOptions,
): SemanticRole {
  return opts?.inactive ? "neutral" : role;
}

/** Convenience: the class trio for a role, after the state rule is applied. */
export function roleClasses(
  role: SemanticRole,
  opts?: ResolveRoleOptions,
): SemanticRoleClasses {
  return SEMANTIC_ROLE_CLASSES[resolveRole(role, opts)];
}

/** Convenience: the solid fill for a role, after the state rule is applied. */
export function roleSolid(
  role: SemanticRole,
  opts?: ResolveRoleOptions,
): SemanticRoleSolid {
  return SEMANTIC_ROLE_SOLID[resolveRole(role, opts)];
}
