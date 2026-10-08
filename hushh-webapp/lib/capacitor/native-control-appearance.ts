"use client";

import { useLayoutEffect, useState } from "react";
import { useTheme } from "next-themes";
import { resolvedAccentHex, useAccent } from "@/lib/theme/accent";
import { parseCssColor } from "@/lib/morphy-ux/ambient-chrome";

export const NATIVE_CONTROL_CONTRACT_VERSION = 2;

/** A projection of existing CSS/theme authority, never a native preference store. */
export type NativeControlAppearance = {
  appearance: "light" | "dark";
  accentHex: string;
  foregroundHex: string;
};

export type NativeControlForeground = "accent" | "secondary";

function secondaryForegroundHex(): string | null {
  const literal = getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(literal)) return literal;
  const [, format, body] = literal.match(/^(rgba?|oklch|oklab|lab)\(([^)]+)\)$/i) ?? [];
  if (!format || !body) return null;
  const rgb = parseCssColor(literal);
  if (!rgb) return null;
  const alphaLiteral = body.includes("/")
    ? body.split("/")[1]?.trim()
    : format.toLowerCase() === "rgba" ? body.split(",")[3]?.trim() : undefined;
  const alpha = alphaLiteral === undefined ? 1
    : Number.parseFloat(alphaLiteral) / (alphaLiteral.endsWith("%") ? 100 : 1);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  // Reuse the shared sRGB conversion; preserve the secondary label's alpha.
  // Native v2 accepts CSS-order #RRGGBBAA, not an independently chosen palette.
  const channels = alpha === 1 ? rgb : [...rgb, alpha * 255];
  return `#${channels.map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("")}`;
}

function committedAppearance(foreground: NativeControlForeground): NativeControlAppearance | null {
  const foregroundHex = foreground === "accent"
    ? resolvedAccentHex("--app-accent-deep")
    : secondaryForegroundHex();
  // Do not substitute the brand accent for a neutral utility glyph. If a
  // wrapper cannot resolve the authored token, retain its DOM presentation.
  if (foregroundHex === null) return null;
  return {
    appearance: document.documentElement.classList.contains("dark") ? "dark" : "light",
    accentHex: resolvedAccentHex(),
    foregroundHex,
  };
}

/** Check at the action boundary, including before the observer's React commit. */
export function isCurrentNativeControlAppearance(projected: NativeControlAppearance, foreground: NativeControlForeground = "accent"): boolean {
  const current = committedAppearance(foreground);
  return current !== null && projected.appearance === current.appearance && projected.accentHex === current.accentHex &&
    projected.foregroundHex === current.foregroundHex;
}

export function useNativeControlAppearance(foreground: NativeControlForeground = "accent"): NativeControlAppearance | null {
  const { resolvedTheme } = useTheme();
  const accent = useAccent();
  const [projection, setProjection] = useState<NativeControlAppearance | null>(null);

  useLayoutEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    const root = document.documentElement;
    const publish = () => {
      // next-themes applies its class in an effect. Observe committed CSS,
      // not an earlier render that still has the previous foreground token.
      const next = committedAppearance(foreground);
      setProjection((current) => next && current?.appearance === next.appearance &&
        current.accentHex === next.accentHex && current.foregroundHex === next.foregroundHex
        ? current : next);
    };
    const observer = new MutationObserver(publish);
    // Bounded to the two preference attributes, never body/children/style or frames.
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-accent"] });
    publish();
    return () => observer.disconnect();
  }, [resolvedTheme, accent, foreground]);

  return projection;
}
