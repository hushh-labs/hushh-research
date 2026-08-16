/**
 * The visible copy of the two One Location onboarding steps, in one place.
 *
 * These strings used to live inline in one-location-onboarding-flow.tsx and were
 * re-typed by hand in __tests__/components/one-location-onboarding-flow.test.tsx,
 * __tests__/components/one-location-agent-page.test.tsx and the Playwright
 * fixture in e2e/one-location-picker-layering.layout.spec.ts. A reword meant a
 * seven-file edit, and the Playwright fixture had already gone stale.
 *
 * Import from here instead of retyping. The layout spec measures THESE strings,
 * so a reword is measured at iPhone widths automatically.
 *
 * Copy rules: four words or fewer for a title, label or button unless meaning,
 * safety or consent needs more. A card's body must not restate its title, and
 * a section subtitle that only lists the cards below it is deleted, not
 * shortened.
 */

export const LOCATION_ONBOARDING_COPY = {
  welcome: {
    eyebrow: "Location Agent",
    heading: "Share where you are.",
    cta: "Get started",
  },
  features: {
    heading: "Keep people updated",
    cta: "Find my people",
    retryCta: "Try again",
    share: {
      tag: "Share location",
      /** Rendered as two lines; each line must stay on one line. */
      titleLines: ["Can’t explain", "where you are?"] as const,
      body: "Share once. Your Circle finds you.",
      proof: "Sharing with Mom, Driver +1",
    },
    checkIn: {
      tag: "Check in",
      titleLines: ["Can’t find", "each other?"] as const,
      // Not "Check in ..." — the tag above already says that, and a card that
      // opens with its own tag wastes the one line answering the title.
      body: "Your Circle knows you’re there.",
      proof: "Checked in at Hotel Grand",
    },
    sos: {
      tag: "SMS · Save My Soul",
      titleLines: ["Can’t call", "for help?"] as const,
      body: "Send your location fast.",
      proof: "Alerted 3 contacts",
    },
  },
} as const;

/** The joined accessible name of a two-line title, as a screen reader gets it. */
export function joinTitleLines(lines: readonly string[]): string {
  return lines.join(" ");
}
