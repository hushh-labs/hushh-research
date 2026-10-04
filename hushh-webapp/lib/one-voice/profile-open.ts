"use client";

/**
 * How a voice `open_screen(profile | profile_privacy |
 * profile_voice_preferences)` reaches the Profile surface.
 *
 * Two presentations exist and the choice is about keeping the docked
 * conversation alive:
 *
 * - On a `/one/*` product route (Location, Connect, ...) Profile opens as the
 *   shell's transient PANE, so the Live session and the screen underneath
 *   stay mounted and the person can keep talking.
 * - When the person is already inside Profile, or asked for a specific detail
 *   (the Account editor, Access & sharing, Voice preferences), the pane cannot
 *   deep-link, so the app navigates to the canonical Profile route instead.
 *
 * The decision is a pure function (`decideProfileOpen`) so it can be unit
 * tested; the voice `navigate` directive (directives.ts) is the one side-effect
 * path, and it settles on what actually showed.
 */

import {
  buildProfileRoute,
  type ProfileDetail,
  type ProfilePanel,
} from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";

export type ProfileOpenPresentation = "route" | "pane";

/** The Profile screens the voice tool catalog can name. */
export type ProfileOpenDetail = "account" | "access" | "preferences/voice";

export type OpenProfileFromVoiceInput = {
  /** The current `window.location.pathname` (or router pathname). */
  pathname: string;
  /** Force a presentation; omitted means "decide from the route". */
  presentation?: ProfileOpenPresentation;
  /** A specific Profile screen; always navigates (the pane cannot deep-link). */
  detail?: ProfileOpenDetail;
};

export type ProfileOpenDecision =
  { kind: "pane"; source: "tap" } | { kind: "route"; href: string };

const PROFILE_DETAIL_TARGETS: Record<
  ProfileOpenDetail,
  { panel: ProfilePanel; detail: ProfileDetail | null }
> = {
  account: { panel: "account", detail: null },
  access: { panel: "my-data", detail: "sharing" },
  "preferences/voice": { panel: "preferences", detail: "voice" },
};

/** The bare pathname: no query or hash, no trailing slash ("/" stays "/"). */
export function normalizePathname(pathname: string): string {
  const raw =
    String(pathname || "")
      .split("?")[0]
      ?.split("#")[0] ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

/** True for `/one/profile` and every screen under it. */
export function isProfilePathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return (
    normalized === ROUTES.PROFILE || normalized.startsWith(`${ROUTES.PROFILE}/`)
  );
}

/** True for `/one` and every product route under it, except Profile itself. */
export function isOneProductPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (isProfilePathname(normalized)) return false;
  return normalized === "/one" || normalized.startsWith("/one/");
}

/**
 * Where a voice request to open Profile should go. Pure; no side effects.
 */
export function decideProfileOpen(
  input: OpenProfileFromVoiceInput,
): ProfileOpenDecision {
  const pathname = normalizePathname(input.pathname);
  const onProfile = isProfilePathname(pathname);
  const onProduct = isOneProductPathname(pathname);

  // Keep the origin so the shared top-bar back control retraces to the
  // screen the person was on, the same way an avatar tap does.
  const searchParams = onProduct
    ? new URLSearchParams({ from: pathname })
    : undefined;

  if (input.detail) {
    const target = PROFILE_DETAIL_TARGETS[input.detail];
    return {
      kind: "route",
      href: buildProfileRoute({
        panel: target.panel,
        detail: target.detail,
        searchParams,
      }),
    };
  }

  if (onProfile || input.presentation === "route") {
    return { kind: "route", href: buildProfileRoute({ searchParams }) };
  }

  if (onProduct || input.presentation === "pane") {
    return { kind: "pane", source: "tap" };
  }

  return { kind: "route", href: buildProfileRoute({ searchParams }) };
}
