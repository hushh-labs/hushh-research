"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { VOICE_ENGINE_CHANGELOG } from "@/lib/agent/voice-engine-changelog";

export function VoiceChangelogPage() {
  return (
    <SettingsGroup>
      {VOICE_ENGINE_CHANGELOG.map((entry, index) => (
        <SettingsRow
          key={`${entry.version}:${entry.title}:${index}`}
          title={entry.title}
          description={entry.description}
          trailing={
            <span className="text-xs text-muted-foreground">{entry.date}</span>
          }
          stackTrailingOnMobile
        />
      ))}
    </SettingsGroup>
  );
}
