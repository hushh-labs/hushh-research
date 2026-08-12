/**
 * How the person got *into* the destination they are standing in.
 *
 * Back is authored: `resolveTopShellBackAction` returns a route's declared
 * parent. Inside a destination that is exactly right -- Analysis climbs to Kai,
 * Kai climbs to One -- and it needs no memory, because the hierarchy is already
 * declared. What the hierarchy cannot know is which destination you came from
 * when you crossed between two of them, and that is the only case where back
 * used to strand people on One home.
 *
 * So this records crossings and nothing else. A move within a destination
 * stores nothing; only a jump between two pushes an entry, consumed when back
 * leaves at the destination's root.
 *
 * A "destination" is an agent section (Location, Kai, PKM...) OR one of the
 * shared bottom-nav surfaces (Connect, Marketplace, Profile). The second half
 * matters: Connect is not an agent capability, so scoping this to sections
 * alone recorded nothing when someone went Location -> Add Connections, and
 * back fell through to One home -- the original bug, one layer along.
 *
 * Deliberately not browser history: that stack carries external origins, and on
 * iOS it would eject the person out of the app. WKWebView has no native stack
 * for Next routes, and the edge-back gesture shares this same contract.
 */

import { resolveAgentSectionForPath } from "@/lib/navigation/agent-sections";
import { isCommonBottomNavRoute } from "@/lib/navigation/app-bottom-nav";
import { ROUTES } from "@/lib/navigation/routes";

type DestinationEntry = {
  destinationId: string;
  /**
   * The in-app href the person was on when they entered. Keeps its query: the
   * reported case was `/one/location?view=people`, and returning to a bare
   * `/one/location` drops them on the wrong tab of the right screen.
   */
  from: string;
};

/** Bounded by how deeply destinations nest, which is shallow in practice. */
const MAX_ENTRIES = 8;

/** Shared surfaces that are destinations without being agent sections. */
const BOTTOM_NAV_ROOTS: readonly string[] = [
  ROUTES.CONNECT,
  ROUTES.MARKETPLACE,
  ROUTES.PROFILE,
];

let entries: DestinationEntry[] = [];
let currentDestinationId: string | null = null;
let currentHref: string | null = null;

function pathOf(href: string | null | undefined): string | null {
  const clean = String(href || "").trim();
  if (!clean.startsWith("/") || clean.startsWith("//")) return null;
  return clean.split(/[?#]/)[0]?.replace(/\/$/, "") || "/";
}

function bottomNavRootFor(path: string): string | null {
  if (!isCommonBottomNavRoute(path)) return null;
  return (
    BOTTOM_NAV_ROOTS.find(
      (root) => path === root || path.startsWith(`${root}/`),
    ) ?? null
  );
}

/** Which destination a path belongs to, or null when it belongs to none. */
export function resolveDestinationId(href: string): string | null {
  const path = pathOf(href);
  if (!path) return null;
  const section = resolveAgentSectionForPath(path);
  if (section) return `section:${section.id}`;
  const root = bottomNavRootFor(path);
  return root ? `nav:${root}` : null;
}

/**
 * True where back leaves the destination rather than climbing inside it. Only
 * a destination's own root qualifies; anything deeper still climbs its
 * declared parents, which is already correct and needs no memory.
 */
export function isDestinationRoot(href: string): boolean {
  const path = pathOf(href);
  if (!path) return false;
  const section = resolveAgentSectionForPath(path);
  if (section) return pathOf(section.href) === path;
  const root = bottomNavRootFor(path);
  return root ? root === path : false;
}

/**
 * Note arrival. Stores an entry only when the destination changed, so moving
 * around inside one costs nothing.
 */
export function recordDestinationEntry(href: string): void {
  const path = pathOf(href);
  if (!path) return;
  const destinationId = resolveDestinationId(path);
  const arrivedHref = String(href).trim();

  if (destinationId && destinationId !== currentDestinationId && currentHref) {
    // Returning to a destination already on the stack is a retrace, not a new
    // entry: unwind to it rather than stacking a second origin for it.
    const existing = entries.findIndex(
      (entry) => entry.destinationId === destinationId,
    );
    if (existing !== -1) {
      entries = entries.slice(0, existing + 1);
    } else {
      entries.push({ destinationId, from: currentHref });
      if (entries.length > MAX_ENTRIES) entries.shift();
    }
  }

  currentDestinationId = destinationId;
  currentHref = arrivedHref;
}

/**
 * Where to leave this destination for, or null when the person did not arrive
 * from another -- a deep link, a cold start, a shared invite link. The declared
 * parent is the right answer in those cases.
 */
export function readDestinationOrigin(href: string): string | null {
  const destinationId = resolveDestinationId(href);
  if (!destinationId) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.destinationId === destinationId) return entry.from;
  }
  return null;
}

/** Drop the entry for this destination once back has spent it. */
export function consumeDestinationOrigin(href: string): void {
  const destinationId = resolveDestinationId(href);
  if (!destinationId) return;
  const index = entries.findIndex(
    (entry) => entry.destinationId === destinationId,
  );
  if (index !== -1) entries = entries.slice(0, index);
}

/** Reset point for a sign-out or an account switch. */
export function clearDestinationOrigins(): void {
  entries = [];
  currentDestinationId = null;
  currentHref = null;
}

/** Test seam: no production caller should read the stack directly. */
export function readDestinationOriginsForTest(): DestinationEntry[] {
  return [...entries];
}
