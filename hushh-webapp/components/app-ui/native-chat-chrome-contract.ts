import type { CSSProperties, ReactNode, Ref, RefObject } from "react";
import type { ChromeAgentSurface, ChromeOption, ChromeAccentPalette } from "@/lib/capacitor/native-chrome-controls";

export type NativeChatChromeHandle = { restoreFocus: (preferNative?: boolean) => Promise<boolean> };

export type NativeChatChromeProps = {
  contentPane?: import("@/lib/capacitor/native-chrome").NativeContentPaneIdentity;
  owner: string | null;
  /** Parent-owned route/session context; include the vault epoch and motion admission. */
  context: string;
  /** True only for the visible, unlocked, stationary owning surface. */
  eligible: boolean;
  /** Interaction only. Busy/disabled state does not retire a valid renderer. */
  enabled?: boolean;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
  /** The authored fallback button (or selected radio), never an inferred DOM control. */
  focusRef: RefObject<HTMLElement | null>;
  /** Layout/activation receipt only; never permission to invoke an operation. */
  onPresentationReady?: () => void;
  /** Explicit feature layer; never inferred from a dialog or its DOM. */
  interactionLayer?: string;
  ref?: Ref<NativeChatChromeHandle>;
} & ({ kind: "map-close"; onActivate: () => void; label: string } |
  { kind: "map-locate"; onActivate: () => void; label: string } |
  { kind: "map-check-in"; value: "idle" | "active"; onActivate: () => void; label: string } |
  { kind: "close"; onActivate: () => void; label: string } |
  { kind: "add"; onActivate: () => void; label: string } |
  { kind: "profile-back"; onActivate: () => void; label: string } |
  { kind: "history"; onActivate: () => void; expanded?: boolean;
  /** Omission or any nonzero count retains the authored notification/badge DOM. Never bridged. */
  pendingAttention?: number } |
  { kind: "agent-surface"; value: ChromeAgentSurface; onValueChange: (value: ChromeAgentSurface) => void } |
  { kind: "appearance"; value: "light" | "dark" | "system"; onValueChange: (value: "light" | "dark" | "system") => void } |
  { kind: "accent"; value: "blue" | "gold"; fullTrigger?: boolean; palette?: ChromeAccentPalette; onValueChange: (value: "blue" | "gold") => void } |
  { kind: "more"; label: string; options: readonly ChromeOption[]; onValueChange: (value: string) => void } |
  { kind: "selection"; label: string; value: string; options: readonly ChromeOption[]; onValueChange: (value: string) => void } |
  { kind: "date"; label: string; value: string; minimum: string; maximum: string; onValueChange: (value: string) => void });
