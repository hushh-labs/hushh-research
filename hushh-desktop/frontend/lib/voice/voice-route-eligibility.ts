"use client";

export function isVoiceEligibleRouteScreen(
  screen: string | null | undefined,
  hideCommandBar: boolean
): boolean {
  if (hideCommandBar) return false;

  const normalized = String(screen || "").trim().toLowerCase();
  if (!normalized || normalized === "app" || normalized === "unknown") {
    return false;
  }

  return true;
}
