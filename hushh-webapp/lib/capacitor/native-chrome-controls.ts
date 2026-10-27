/** Public presentation vocabulary only; no routes, private content or operations. */
export type ChromeControlId = "top-shell-back" | "profile-back" | "chat-history-toggle" | "chat-history-close" | "chat-agent-surface" | "stationary-more" | "stationary-add" | "bounded-selection" | "bounded-date" | "profile-close" | "profile-appearance" | "profile-accent";
export type ChromeFamily = "back" | "profile-back" | "history" | "history-close" | "agent-surface" | "more" | "add" | "selection" | "date" | "close" | "appearance" | "accent";
export type ChromeAgentSurface = "one" | "puppy";
export type ChromeOption = { value: string; label: string; disabled?: boolean };
export type ChromeAccentPalette = { blue: string; gold: string };
export type ChromeControl = { kind: "back" | "profile-back" | "close" | "add" } | { kind: "history" | "history-close"; expanded?: boolean } |
  { kind: "agent-surface"; value: ChromeAgentSurface } |
  { kind: "appearance"; value: "light" | "dark" | "system" } |
  { kind: "accent"; value: "blue" | "gold"; fullTrigger?: boolean; palette?: ChromeAccentPalette } |
  { kind: "more"; options: readonly ChromeOption[] } |
  { kind: "selection"; value: string; options: readonly ChromeOption[] } |
  { kind: "date"; value: string; minimum: string; maximum: string };

export function chromeControlId(kind: ChromeFamily): ChromeControlId {
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
