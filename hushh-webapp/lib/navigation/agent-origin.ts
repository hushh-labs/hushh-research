/**
 * Where the full-page `/agent` route should return to when it is minimized.
 *
 * Minimize used to infer this from `document.referrer`, which App Router client
 * navigation never updates — every entry point into `/agent` is a client
 * `router.push`, so the referrer stayed empty and minimize always fell through
 * to One home. The origin is therefore carried explicitly in the URL instead:
 * it survives a reload, a shared link and a restored tab, none of which a
 * history- or referrer-based heuristic can.
 */

import { ROUTES } from "@/lib/navigation/routes";

export const AGENT_ORIGIN_PARAM = "from";

/**
 * `/agent?from=<originPath>` — the href a feature page hands off to so minimize
 * can retrace it. A path that is not a safe in-app target is dropped rather
 * than encoded, so the link degrades to the plain route.
 */
export function agentRouteWithOrigin(
  originPath: string | null | undefined,
): string {
  const safe = normalizeAgentOrigin(originPath);
  if (!safe) return ROUTES.AGENT;
  return `${ROUTES.AGENT}?${AGENT_ORIGIN_PARAM}=${encodeURIComponent(safe)}`;
}

/**
 * The return path recorded on a `/agent` URL, or null when there is none to
 * trust. Accepts a full search string (`?from=/one/email`) or a bare one.
 */
export function readAgentOrigin(
  search: string | null | undefined,
): string | null {
  if (!search) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    ).get(AGENT_ORIGIN_PARAM);
  } catch {
    return null;
  }
  return normalizeAgentOrigin(raw);
}

/**
 * Reduce a candidate to a same-origin app path, or null.
 *
 * The value reaches us from the query string, so it is attacker-controllable in
 * a shared link: anything that could leave the origin has to be rejected, not
 * sanitised. That means a single leading slash only — `//evil.com` is
 * protocol-relative and `https://evil.com` carries a scheme, and both would
 * navigate off-site. `/agent` itself is rejected too, so minimize can never
 * return to the screen it is leaving.
 */
function normalizeAgentOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  // URL parsing strips embedded TAB/LF/CR; reject them before normalization.
  if (
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const base = "https://agent-origin.invalid";
  try {
    const parsed = new URL(trimmed, base);
    if (parsed.origin !== base) return null;
    if (parsed.pathname.replace(/\/+$/, "") === ROUTES.AGENT) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
