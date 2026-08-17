import { describe, expect, it } from "vitest";

import { AGENT_THEME_BY_TONE } from "@/lib/design/agent-theme-registry";

/**
 * #5393 — the agent dashboard icons read as dull and washed out.
 *
 * This is a COMPUTED contract, not a string match. A string test would pass
 * the moment someone swapped one pale hex for another; this recomputes the
 * ratio from the hex itself, so reverting any fill to its old Apple system
 * value fails here with the number that made it fail.
 *
 * WCAG 2.2 SC 1.4.11 (Non-text Contrast) asks 3:1 of a graphical object.
 * Two separate measurements matter for a chip like this and only one of them
 * is obvious:
 *
 *   glyph vs chip  — can you read the icon
 *   chip  vs card  — can you see the chip at all
 *
 * The old dashboard passed neither: its 14–16% alpha tints sat at 1.20–1.26:1
 * against the white card, which is what "dull" meant.
 */

const CARD_LIGHT = "#FFFFFF";
const CARD_DARK = "#1C1C1E";
const MINIMUM_RATIO = 3;

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((raw) => {
    const channel = raw / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (high + 0.05) / (low + 0.05);
}

/**
 * `location` is the one tone whose fill is a token rather than a hex, because
 * it follows the accent preference. Its two possible values are covered by
 * their own case below.
 */
const LITERAL_TONE_FILLS = Object.entries(AGENT_THEME_BY_TONE).filter(
  ([, theme]) => theme.iconBackground.startsWith("#"),
);

describe("agent icon palette contrast (#5393)", () => {
  it("covers every tone in the registry", () => {
    const tokenBacked = Object.entries(AGENT_THEME_BY_TONE).filter(
      ([, theme]) => !theme.iconBackground.startsWith("#"),
    );
    expect(LITERAL_TONE_FILLS.length + tokenBacked.length).toBe(
      Object.keys(AGENT_THEME_BY_TONE).length,
    );
    // Guards against a tone being added and silently skipped by the filter.
    expect(tokenBacked.map(([tone]) => tone)).toEqual(["location"]);
  });

  it.each(LITERAL_TONE_FILLS)(
    "carries a readable white glyph on the %s chip",
    (_tone, theme) => {
      const ratio = contrastRatio("#FFFFFF", theme.iconBackground);
      expect(
        `${theme.iconBackground} glyph ${ratio.toFixed(2)}:1`,
      ).toBe(`${theme.iconBackground} glyph ${Math.max(ratio, MINIMUM_RATIO).toFixed(2)}:1`);
    },
  );

  it.each(LITERAL_TONE_FILLS)(
    "keeps the %s chip visible against both cards",
    (_tone, theme) => {
      for (const card of [CARD_LIGHT, CARD_DARK]) {
        const ratio = contrastRatio(theme.iconBackground, card);
        expect(
          `${theme.iconBackground} on ${card} ${ratio.toFixed(2)}:1`,
        ).toBe(
          `${theme.iconBackground} on ${card} ${Math.max(ratio, MINIMUM_RATIO).toFixed(2)}:1`,
        );
      }
    },
  );

  it("uses one fill per tone in light and dark", () => {
    // The bug report asked for "consistent icon weight and palette across
    // dark and light themes". One value per tone is how that stays true
    // without a second palette drifting away from the first.
    for (const [tone, theme] of Object.entries(AGENT_THEME_BY_TONE)) {
      expect(`${tone}:${theme.iconBackgroundDark}`).toBe(
        `${tone}:${theme.iconBackground}`,
      );
      expect(`${tone}:${theme.iconClassName}`).toContain(
        theme.iconBackground.startsWith("#")
          ? theme.iconBackground
          : "var(--app-accent)",
      );
    }
  });

  it("does not let the accent-driven tone ship a white glyph on gold", () => {
    // `location` is the only fill that follows the accent preference. Under
    // Molten Gold (#d4a574) a white glyph measures 2.23:1 and the accent's
    // own on-accent ink measures 7.56:1, so the tone has to defer to the
    // token rather than hardcode white.
    expect(contrastRatio("#FFFFFF", "#d4a574")).toBeLessThan(MINIMUM_RATIO);
    expect(contrastRatio("#1d1d1f", "#d4a574")).toBeGreaterThan(MINIMUM_RATIO);
    expect(
      (AGENT_THEME_BY_TONE.location.iconStyle as Record<string, string>)[
        "--agent-icon-glyph"
      ],
    ).toBe("var(--app-accent-fg)");
  });

  it("still separates the agents it used to collapse", () => {
    // Nine agents rendered in three tint families. Only gmail and email may
    // share a fill now — they are the same tone by design.
    const fills = Object.values(AGENT_THEME_BY_TONE).map(
      (theme) => theme.iconBackground,
    );
    expect(new Set(fills).size).toBeGreaterThanOrEqual(7);
  });
});
