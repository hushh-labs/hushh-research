"use client";

import { useEffect, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { PageSubtitle } from "@/components/app-ui/typography";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  readVoicePreferences,
  subscribeVoicePreferences,
  updateVoicePreferences,
  type OneVoicePreferencesState,
} from "@/lib/agent/voice-preferences";
import {
  VOICE_ENGINE_CHANGELOG,
  VOICE_ENGINE_VERSION,
} from "@/lib/agent/voice-engine-changelog";
import { VOICE_ENGINE_DOMAINS } from "@/lib/agent/voice-engine-domains";

const CHANGELOG_PREVIEW_COUNT = 2;

function VoiceHeader() {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 pb-2 pt-1 text-center">
      <h1
        className="bg-clip-text text-[40px] font-bold leading-tight tracking-tight text-transparent"
        style={{
          backgroundImage:
            "linear-gradient(120deg, var(--app-accent-hero-from), var(--app-accent-hero-mid), var(--app-accent-hero-to))",
        }}
      >
        One
      </h1>
      <PageSubtitle className="text-muted-foreground">
        Voice engine version {VOICE_ENGINE_VERSION} — powered by Gemini Live
      </PageSubtitle>
    </div>
  );
}

function VoiceChangelog() {
  const [expanded, setExpanded] = useState(false);
  const entries = expanded
    ? VOICE_ENGINE_CHANGELOG
    : VOICE_ENGINE_CHANGELOG.slice(0, CHANGELOG_PREVIEW_COUNT);
  const hasMore = VOICE_ENGINE_CHANGELOG.length > CHANGELOG_PREVIEW_COUNT;

  return (
    <SettingsGroup title="What's new">
      {entries.map((entry, index) => (
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
      {hasMore && !expanded ? (
        <SettingsRow
          title="See all updates"
          onClick={() => setExpanded(true)}
          chevron
        />
      ) : null}
    </SettingsGroup>
  );
}

export function VoicePreferencesPanel({
  userId,
}: {
  userId: string | null;
}) {
  const [state, setState] = useState<OneVoicePreferencesState>(() =>
    readVoicePreferences(userId),
  );

  useEffect(() => {
    setState(readVoicePreferences(userId));
    if (!userId) return;
    return subscribeVoicePreferences(userId, setState);
  }, [userId]);

  const set = (updater: (current: OneVoicePreferencesState) => OneVoicePreferencesState) => {
    updateVoicePreferences(userId, updater);
  };

  return (
    <div className="space-y-4">
      <VoiceHeader />
      <VoiceChangelog />
      <SettingsGroup>
        <SettingsRow
          title="Voice control"
          description="Let One act on what you say, everywhere in the app."
          trailing={
            <Switch
              checked={state.voiceEnabled}
              onCheckedChange={(checked) =>
                set((current) => ({ ...current, voiceEnabled: checked }))
              }
              aria-label="Voice control"
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup
        title="Safety"
        description="Applies to actions that already ask for confirmation, like sharing your location or sending an SOS."
      >
        <SettingsRow
          title="Require a tap to confirm risky actions"
          description="Turn this on to stop a spoken yes or no from confirming them."
          disabled={!state.voiceEnabled}
          trailing={
            <Switch
              checked={state.requireTapConfirmation}
              disabled={!state.voiceEnabled}
              onCheckedChange={(checked) =>
                set((current) => ({ ...current, requireTapConfirmation: checked }))
              }
              aria-label="Require a tap to confirm risky actions"
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup
        title="What voice can control"
        description="Turn a domain off to stop voice from acting there. You can still use it by tap."
      >
        {VOICE_ENGINE_DOMAINS.map((domain) => {
          const allowed = !state.disabledDomains.includes(domain.key);
          return (
            <SettingsRow
              key={domain.key}
              title={domain.label}
              description={domain.description}
              disabled={!state.voiceEnabled || !domain.enforced}
              trailing={
                domain.enforced ? (
                  <Switch
                    checked={allowed}
                    disabled={!state.voiceEnabled}
                    onCheckedChange={(checked) =>
                      set((current) => ({
                        ...current,
                        disabledDomains: checked
                          ? current.disabledDomains.filter((key) => key !== domain.key)
                          : [...current.disabledDomains, domain.key],
                      }))
                    }
                    aria-label={domain.label}
                  />
                ) : (
                  <Badge variant="secondary">Coming soon</Badge>
                )
              }
            />
          );
        })}
      </SettingsGroup>
    </div>
  );
}
