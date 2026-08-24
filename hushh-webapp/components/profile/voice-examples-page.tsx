"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { VOICE_AGENT_EXAMPLE_GROUPS } from "@/lib/agent/voice-agent-examples";

export function VoiceExamplesPage() {
  return (
    <div className="space-y-4">
      <p className="px-1 text-sm text-muted-foreground">
        Tap the mic and say it in your own words -- these are just a starting point.
      </p>
      {VOICE_AGENT_EXAMPLE_GROUPS.map((group) => (
        <SettingsGroup key={group.key} title={group.label}>
          {group.examples.map((example) => (
            <SettingsRow
              key={example.phrase}
              title={`“${example.phrase}”`}
              description={example.result}
            />
          ))}
        </SettingsGroup>
      ))}
      <p className="px-1 text-sm text-muted-foreground">
        Finance and Calendar are coming to voice soon.
      </p>
    </div>
  );
}
