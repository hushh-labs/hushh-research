"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { resolvedAccentHex, useAccent } from "@/lib/theme/accent";

export const NATIVE_CONTROL_CONTRACT_VERSION = 2;

/** A projection of existing CSS/theme authority, never a native preference store. */
export type NativeControlAppearance = {
  appearance: "light" | "dark";
  accentHex: string;
  foregroundHex: string;
};

function committedAppearance(): NativeControlAppearance {
  return {
    appearance: document.documentElement.classList.contains("dark") ? "dark" : "light",
    accentHex: resolvedAccentHex(),
    foregroundHex: resolvedAccentHex("--app-accent-deep"),
  };
}

/** Check at the action boundary, including before the observer's React commit. */
export function isCurrentNativeControlAppearance(projected: NativeControlAppearance): boolean {
  const current = committedAppearance();
  return projected.appearance === current.appearance && projected.accentHex === current.accentHex &&
    projected.foregroundHex === current.foregroundHex;
}

export function useNativeControlAppearance(): NativeControlAppearance | null {
  const { resolvedTheme } = useTheme();
  const accent = useAccent();
  const [projection, setProjection] = useState<NativeControlAppearance | null>(null);

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    const root = document.documentElement;
    const publish = () => {
      // next-themes applies its class in an effect. Observe committed CSS,
      // not an earlier render that still has the previous foreground token.
      const next = committedAppearance();
      setProjection((current) => current?.appearance === next.appearance &&
        current.accentHex === next.accentHex && current.foregroundHex === next.foregroundHex
        ? current : next);
    };
    const observer = new MutationObserver(publish);
    // Bounded to the two preference attributes, never body/children/style or frames.
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-accent"] });
    publish();
    return () => observer.disconnect();
  }, [resolvedTheme, accent]);

  return projection;
}
