export type ThemePreference = "light" | "dark" | "system";

const THEME_PREFERENCE_ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

export function resolveThemePreference(
  theme: string | null | undefined,
): ThemePreference | null {
  const normalized = (theme ?? "").trim().toLowerCase();
  if (normalized === "light" || normalized === "dark" || normalized === "system") {
    return normalized;
  }
  return null;
}

/**
 * Theme controls have three intentional states. An unhydrated/unknown value
 * behaves as System, preserving the default before next-themes is ready.
 */
export function nextThemePreference(theme: string | null | undefined): ThemePreference {
  const current = resolveThemePreference(theme) ?? "system";
  const currentIndex = THEME_PREFERENCE_ORDER.indexOf(current);
  return THEME_PREFERENCE_ORDER[(currentIndex + 1) % THEME_PREFERENCE_ORDER.length]!;
}
