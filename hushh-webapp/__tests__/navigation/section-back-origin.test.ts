import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgentSectionForPath } from "@/lib/navigation/agent-sections";
import {
  clearSectionOrigins,
  isSectionRoot,
  readSectionOrigin,
  readSectionOriginsForTest,
  recordSectionEntry,
} from "@/lib/navigation/section-back-origin";
import {
  navigateTopShellBack,
  resolveTopShellBackAction,
} from "@/lib/navigation/top-shell-back";

const KAI = "/one/kai";
const KAI_ANALYSIS = "/one/kai/analysis";
const LOCATION = "/one/location";
const ONE_HOME = "/one";

beforeEach(() => {
  clearSectionOrigins();
});

/**
 * Inside a section the declared parent already climbs correctly and needs no
 * memory. The hierarchy simply cannot know which section the person crossed in
 * from, and that is the only case back got wrong: One home is what *contains*
 * Location, so entering Location from Finance and pressing back landed there.
 */
describe("section entry recording", () => {
  it("stores nothing for a move inside one section", () => {
    recordSectionEntry(KAI);
    recordSectionEntry(KAI_ANALYSIS);

    expect(readSectionOriginsForTest()).toEqual([]);
  });

  it("stores one entry when crossing between sections", () => {
    recordSectionEntry(KAI);
    recordSectionEntry(KAI_ANALYSIS);
    recordSectionEntry(LOCATION);

    const stored = readSectionOriginsForTest();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.from).toBe(KAI_ANALYSIS);
  });

  it("ignores query and hash, so an overlay is never an entry", () => {
    recordSectionEntry(KAI);
    recordSectionEntry(`${LOCATION}?action=share`);
    recordSectionEntry(`${LOCATION}#map`);

    expect(readSectionOriginsForTest()).toHaveLength(1);
  });

  it("refuses anything that is not an in-app absolute path", () => {
    recordSectionEntry(KAI);
    recordSectionEntry("https://example.com/one/location");
    recordSectionEntry("//evil.example.com");

    expect(readSectionOriginsForTest()).toEqual([]);
  });

  it("unwinds rather than stacking when a section is re-entered", () => {
    recordSectionEntry(ONE_HOME);
    recordSectionEntry(KAI);
    recordSectionEntry(LOCATION);
    recordSectionEntry(KAI);

    // Back in Kai, so Location's origin is spent, not kept alongside a second
    // Kai entry that would grow every time the person moved between two
    // sections.
    const ids = readSectionOriginsForTest().map((entry) => entry.sectionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(readSectionOrigin(LOCATION)).toBeNull();
  });
});

describe("back leaves a section by its origin and climbs inside one", () => {
  it("returns to the section the person came from", () => {
    recordSectionEntry(KAI);
    recordSectionEntry(LOCATION);

    // Location's declared parent is One home. The person came from Kai.
    expect(resolveTopShellBackAction({ pathname: LOCATION })).toEqual({
      href: KAI,
      mode: "push",
    });
  });

  it("climbs the hierarchy inside a section, ignoring the origin", () => {
    recordSectionEntry(LOCATION);
    recordSectionEntry(KAI);
    recordSectionEntry(KAI_ANALYSIS);

    // Analysis is not a section root, so back climbs to its declared parent
    // rather than jumping out to Location.
    const action = resolveTopShellBackAction({ pathname: KAI_ANALYSIS });
    expect(action?.href).not.toBe(LOCATION);
    expect(isSectionRoot(KAI_ANALYSIS)).toBe(false);
  });

  it("falls back to the declared parent with no recorded origin", () => {
    // A deep link, a cold start, a shared invite link. Unchanged behaviour.
    expect(resolveTopShellBackAction({ pathname: "/ria/onboarding" })).toEqual({
      href: ONE_HOME,
      mode: "push",
    });
  });

  it("spends the origin so a later visit does not retrace a stale route", () => {
    recordSectionEntry(KAI);
    recordSectionEntry(LOCATION);
    const navigate = vi.fn();

    navigateTopShellBack({ pathname: LOCATION, navigate });
    expect(navigate).toHaveBeenCalledWith({ href: KAI, mode: "push" });
    expect(readSectionOrigin(LOCATION)).toBeNull();
  });

  it("closes an open action sheet in place instead of leaving the section", () => {
    recordSectionEntry(KAI);
    recordSectionEntry(LOCATION);
    const navigate = vi.fn();

    navigateTopShellBack({
      pathname: LOCATION,
      searchParams: new URLSearchParams("action=share"),
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith({ href: LOCATION, mode: "replace" });
    // The overlay closed; the origin is still owed for when they actually go.
    expect(readSectionOrigin(LOCATION)).toBe(KAI);
  });

  it("still reports no back where the shell hides it", () => {
    recordSectionEntry(KAI);
    recordSectionEntry(LOCATION);

    // The iOS edge-back gesture enables itself from this returning an action,
    // so when back exists must not shift.
    expect(
      resolveTopShellBackAction({
        pathname: LOCATION,
        breadcrumb: { backHref: ONE_HOME, hideBack: true, items: [] },
      }),
    ).toBeNull();
  });

  it("treats a section root as the exit point", () => {
    expect(isSectionRoot(LOCATION)).toBe(true);
    expect(resolveAgentSectionForPath(LOCATION)).not.toBeNull();
  });
});
