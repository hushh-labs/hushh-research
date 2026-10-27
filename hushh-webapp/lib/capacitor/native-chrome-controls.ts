/** Public presentation vocabulary only; no routes, private content or operations. */
export type ChromeMapAction = "map-close" | "map-locate" | "map-check-in";
export type ChromeControlId = ChromeMapAction | "top-shell-back" | "profile-back" | "chat-history-toggle" | "chat-history-close" | "chat-agent-surface" | "stationary-more" | "stationary-add" | "bounded-selection" | "bounded-date" | "profile-close" | "profile-appearance" | "profile-accent";
export type ChromeFamily = ChromeMapAction | "back" | "profile-back" | "history" | "history-close" | "agent-surface" | "more" | "add" | "selection" | "date" | "close" | "appearance" | "accent";
export type ChromeAgentSurface = "one" | "puppy";
export type ChromeOption = { value: string; label: string; disabled?: boolean };
export type ChromeAccentPalette = { blue: string; gold: string };
export type ChromeControl = { kind: "map-close" | "map-locate" } | { kind: "map-check-in"; value: "idle" | "active" } | { kind: "back" | "profile-back" | "close" | "add" } | { kind: "history" | "history-close"; expanded?: boolean } |
  { kind: "agent-surface"; value: ChromeAgentSurface } |
  { kind: "appearance"; value: "light" | "dark" | "system" } |
  { kind: "accent"; value: "blue" | "gold"; fullTrigger?: boolean; palette?: ChromeAccentPalette } |
  { kind: "more"; options: readonly ChromeOption[] } |
  { kind: "selection"; value: string; options: readonly ChromeOption[] } |
  { kind: "date"; value: string; minimum: string; maximum: string };

export function chromeControlId(kind: ChromeFamily): ChromeControlId {
  if (kind === "map-close" || kind === "map-locate" || kind === "map-check-in") return kind;
  if (kind === "add") return "stationary-add";
  if (kind === "history-close") return "chat-history-close";
  if (kind === "profile-back") return "profile-back";
  if (kind === "history") return "chat-history-toggle";
  if (kind === "agent-surface") return "chat-agent-surface";
  if (kind === "appearance") return "profile-appearance";
  if (kind === "accent") return "profile-accent";
  if (kind === "more") return "stationary-more";
  if (kind === "selection") return "bounded-selection";
  if (kind === "date") return "bounded-date";
  if (kind === "close") return "profile-close";
  return "top-shell-back";
}

/** Preserve each authored family's exact geometry; no generic size relaxation. */
export function nativeChromeSizeAllowed(kind: ChromeFamily, width: number, height: number): boolean {
  if (kind === "map-close" || kind === "map-locate") return width === 56 && height === 56;
  if (kind === "map-check-in") return width === 112 && height === 44;
  if (height !== 44) return false;
  if (kind === "accent") return width === 44 || width >= 132 && width <= 320;
  if (kind === "appearance") return width >= 132 && width <= 320;
  if (kind === "agent-surface") return width >= 88 && width <= 320;
  return width === 44;
}
