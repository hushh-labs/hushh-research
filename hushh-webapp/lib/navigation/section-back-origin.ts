/**
 * How the person got *into* the section they are standing in.
 *
 * Back is authored: `resolveTopShellBackAction` returns a route's declared
 * parent. Inside a section that is exactly right -- Analysis climbs to Kai,
 * Kai climbs to One -- and it needs no memory at all, because the hierarchy is
 * already declared. The one thing the hierarchy cannot know is which section
 * you came from when you crossed between two of them, and that is the only
 * case where back used to dump people on One home: home is what *contains*
 * Location, so entering Location from Finance and pressing back landed there.
 *
 * So this records section entries and nothing else. A move within a section
 * stores nothing. Only a jump between sections -- Finance to PKM, Kai to
 * Location -- pushes one entry, and back consumes it at the section root.
 *
 * Deliberately not browser history: that stack carries external origins, and
 * on iOS it would eject the person out of the app. WKWebView has no native
 * stack for Next routes, and the edge-back gesture shares this same contract.
 */

import { resolveAgentSectionForPath } from "@/lib/navigation/agent-sections";

type SectionEntry = {
  sectionId: string;
  /** The in-app pathname the person was on when they entered this section. */
  from: string;
};

/** Bounded by how deeply sections can nest, which is shallow in practice. */
const MAX_ENTRIES = 8;

let entries: SectionEntry[] = [];
let currentSectionId: string | null = null;
let currentPathname: string | null = null;

function normalize(pathname: string | null | undefined): string | null {
  const clean = String(pathname || "").trim();
  if (!clean.startsWith("/") || clean.startsWith("//")) return null;
  return clean.split(/[?#]/)[0] || null;
}

/**
 * Note arrival at a pathname. Stores an entry only when the section changed,
 * so navigating around inside one section costs nothing.
 */
export function recordSectionEntry(pathname: string): void {
  const path = normalize(pathname);
  if (!path) return;
  const sectionId = resolveAgentSectionForPath(path)?.id ?? null;

  if (sectionId && sectionId !== currentSectionId && currentPathname) {
    // Returning to a section already on the stack is a retrace, not a new
    // entry: unwind to it rather than stacking a second origin for it.
    const existing = entries.findIndex((entry) => entry.sectionId === sectionId);
    if (existing !== -1) {
      entries = entries.slice(0, existing + 1);
    } else {
      entries.push({ sectionId, from: currentPathname });
      if (entries.length > MAX_ENTRIES) entries.shift();
    }
  }

  currentSectionId = sectionId;
  currentPathname = path;
}

/**
 * Where to leave this section for, or null when the person did not arrive
 * from another section -- a deep link, a cold start, a shared invite link.
 * The authored parent is the right answer in those cases.
 */
export function readSectionOrigin(pathname: string): string | null {
  const path = normalize(pathname);
  if (!path) return null;
  const sectionId = resolveAgentSectionForPath(path)?.id ?? null;
  if (!sectionId) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.sectionId === sectionId) return entry.from;
  }
  return null;
}

/** True when this pathname is the section's own root, where back leaves it. */
export function isSectionRoot(pathname: string): boolean {
  const path = normalize(pathname);
  if (!path) return false;
  const section = resolveAgentSectionForPath(path);
  if (!section) return false;
  return normalize(section.href) === path;
}

/** Drop the entry for this section once back has spent it. */
export function consumeSectionOrigin(pathname: string): void {
  const path = normalize(pathname);
  if (!path) return;
  const sectionId = resolveAgentSectionForPath(path)?.id ?? null;
  if (!sectionId) return;
  const index = entries.findIndex((entry) => entry.sectionId === sectionId);
  if (index !== -1) entries = entries.slice(0, index);
}

/** Reset point for a sign-out or an account switch. */
export function clearSectionOrigins(): void {
  entries = [];
  currentSectionId = null;
  currentPathname = null;
}

/** Test seam: no production caller should read the stack directly. */
export function readSectionOriginsForTest(): SectionEntry[] {
  return [...entries];
}
