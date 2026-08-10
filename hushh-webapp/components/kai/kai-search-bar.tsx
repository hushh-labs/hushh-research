"use client";

import { useEffect, useState } from "react";

import {
  KaiCommandPalette,
  type KaiCommandPaletteSelection,
} from "@/components/kai/kai-command-palette";
import {
  KAI_COMMAND_BAR_OPEN_EVENT,
  KAI_COMMAND_BAR_TOGGLE_EVENT,
} from "@/lib/navigation/kai-command-bar-events";
import type { VoiceCapabilityStateV1 } from "@/lib/voice/capability-projection";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

/**
 * Typed command-palette host.
 *
 * One Agent Bar is the only microphone and natural-language voice surface.
 * This component deliberately owns only keyboard/search discovery and forwards
 * a free-form prompt to the same Agent Chat handoff.
 */
export function KaiSearchBar({
  onSelectAction,
  onSubmitPrompt,
  disabled = false,
  appRuntimeState,
  capabilityState,
  surfaceMetadata,
  portfolioTickers = [],
}: {
  onSelectAction: (selection: KaiCommandPaletteSelection) => void;
  onSubmitPrompt: (prompt: string) => void;
  disabled?: boolean;
  appRuntimeState?: AppRuntimeState;
  capabilityState?: VoiceCapabilityStateV1;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  portfolioTickers?: Array<{
    symbol: string;
    name?: string;
    sector?: string;
    asset_type?: string;
    is_investable?: boolean;
    analyze_eligible?: boolean;
  }>;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const openPalette = () => setOpen(true);
    const togglePalette = () => setOpen((current) => !current);
    window.addEventListener(KAI_COMMAND_BAR_OPEN_EVENT, openPalette);
    window.addEventListener(KAI_COMMAND_BAR_TOGGLE_EVENT, togglePalette);
    return () => {
      window.removeEventListener(KAI_COMMAND_BAR_OPEN_EVENT, openPalette);
      window.removeEventListener(KAI_COMMAND_BAR_TOGGLE_EVENT, togglePalette);
    };
  }, []);

  return (
    <KaiCommandPalette
      open={open}
      onOpenChange={setOpen}
      onSelectAction={onSelectAction}
      onSubmitPrompt={onSubmitPrompt}
      appRuntimeState={appRuntimeState}
      capabilityState={capabilityState}
      surfaceMetadata={surfaceMetadata}
      disabled={disabled}
      portfolioTickers={portfolioTickers}
    />
  );
}
