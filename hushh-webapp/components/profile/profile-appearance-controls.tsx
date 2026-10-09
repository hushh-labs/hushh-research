"use client";

import { AccentRowIcon, AppearanceRowIcon } from "@/components/icons/agents";
import { NativeAccentChoice } from "@/components/app-ui/native-accent-choice";
import { ThemeToggleLean } from "@/components/theme-toggle";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import type { AppAccent } from "@/lib/theme/accent";

/** Shared public controls; their existing theme/accent services own commits. */
export function ProfileAppearanceControls({ value, nativeContext }: {
  value: AppAccent;
  nativeContext: { owner: string | null; context: string; eligible: boolean };
}) {
  return <SettingsGroup rowSizing="uniform">
    <SettingsRow icon={AppearanceRowIcon} iconTone="capability" title="Appearance"
      trailing={<ThemeToggleLean size="compact" className="w-[132px] min-w-0" nativeContext={nativeContext} />} />
    <SettingsRow icon={AccentRowIcon} iconTone="capability" title="Accent"
      trailing={<NativeAccentChoice value={value} {...nativeContext} />} />
  </SettingsGroup>;
}
