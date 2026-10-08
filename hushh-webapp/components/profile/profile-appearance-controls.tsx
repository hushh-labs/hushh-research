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
  return <SettingsGroup>
    <SettingsRow icon={AppearanceRowIcon} iconTone="capability" title="Appearance"
      description="Light, dark, or system." stackTrailingOnMobile
      trailing={<ThemeToggleLean size="expanded" className="w-full sm:w-60 min-w-0" nativeContext={nativeContext} />} />
    <SettingsRow icon={AccentRowIcon} iconTone="capability" title="Accent"
      description="Choose the app accent." stackTrailingOnMobile
      trailing={<NativeAccentChoice value={value} {...nativeContext} />} />
  </SettingsGroup>;
}
