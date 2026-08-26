"use client";

import { useEffect, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { PageSubtitle } from "@/components/app-ui/typography";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { VOICE_PERSONA_OPTIONS } from "@/lib/agent/voice-persona-options";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationSosVoiceDefaultAction } from "@/lib/one-location/types";
import { ConnectionsService } from "@/lib/services/connections-service";

/** Select has no null option, so the default pick gets its own sentinel value. */
const VOICE_NAME_DEFAULT_VALUE = "__default__";

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
        Voice engine {VOICE_ENGINE_VERSION} — powered by Gemini Live
      </PageSubtitle>
    </div>
  );
}

function VoiceChangelog({ onOpenChangelog }: { onOpenChangelog: () => void }) {
  const entries = VOICE_ENGINE_CHANGELOG.slice(0, CHANGELOG_PREVIEW_COUNT);
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
      {hasMore ? (
        <SettingsRow
          title="See all updates"
          onClick={onOpenChangelog}
          chevron
        />
      ) : null}
    </SettingsGroup>
  );
}

type LocationAgentDefaults = {
  autoApproveRequests: boolean;
  nearbyCheckInVisible: boolean;
  nearbyCheckInAllowConnectionRequests: boolean;
  sosDefaultAction: OneLocationSosVoiceDefaultAction;
};

function LocationAgentDefaultsGroup({
  vaultOwnerToken,
}: {
  vaultOwnerToken: string | null;
}) {
  const [defaults, setDefaults] = useState<LocationAgentDefaults | null>(null);

  useEffect(() => {
    if (!vaultOwnerToken) return;
    let cancelled = false;
    OneLocationService.getState(vaultOwnerToken)
      .then((state) => {
        if (cancelled) return;
        setDefaults({
          autoApproveRequests: Boolean(state.autoApprovePreference?.enabled),
          nearbyCheckInVisible: state.nearbyCheckInPreferences?.visible ?? true,
          nearbyCheckInAllowConnectionRequests:
            state.nearbyCheckInPreferences?.allowConnectionRequests ?? false,
          sosDefaultAction: state.sosVoicePreference?.defaultAction ?? "open",
        });
      })
      .catch(() => {
        // Settings row disappears rather than showing a stale or wrong
        // default; the person can reopen the page to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [vaultOwnerToken]);

  if (!vaultOwnerToken || !defaults) return null;

  const setNearbyCheckIn = (
    updater: (current: LocationAgentDefaults) => LocationAgentDefaults,
  ) => {
    setDefaults((current) => {
      if (!current) return current;
      const next = updater(current);
      OneLocationService.updateNearbyCheckInPreferences({
        vaultOwnerToken,
        visible: next.nearbyCheckInVisible,
        allowConnectionRequests: next.nearbyCheckInAllowConnectionRequests,
      }).catch(() => setDefaults(current));
      return next;
    });
  };

  const setSosDefault = (defaultAction: OneLocationSosVoiceDefaultAction) => {
    setDefaults((current) => {
      if (!current) return current;
      OneLocationService.updateSosVoicePreference({
        vaultOwnerToken,
        defaultAction,
      }).catch(() => setDefaults(current));
      return { ...current, sosDefaultAction: defaultAction };
    });
  };

  return (
    <SettingsGroup
      title="Location"
      description="Defaults One uses for location requests and Nearby Check-In."
    >
      <SettingsRow
        title="Auto-approve requests"
        description="Let matching location requests through automatically."
        trailing={
          <Switch
            checked={defaults.autoApproveRequests}
            onCheckedChange={(checked) => {
              setDefaults((current) =>
                current ? { ...current, autoApproveRequests: checked } : current,
              );
              OneLocationService.updateAutoApprovePreference({
                vaultOwnerToken,
                enabled: checked,
                scope: checked ? { kind: "all_contacts" } : undefined,
              }).catch(() =>
                setDefaults((current) =>
                  current ? { ...current, autoApproveRequests: !checked } : current,
                ),
              );
            }}
            aria-label="Auto-approve requests"
          />
        }
      />
      <SettingsRow
        title="Visible in Nearby Check-In"
        description="Show up to people nearby when you check in."
        trailing={
          <Switch
            checked={defaults.nearbyCheckInVisible}
            onCheckedChange={(checked) =>
              setNearbyCheckIn((current) => ({
                ...current,
                nearbyCheckInVisible: checked,
              }))
            }
            aria-label="Visible in Nearby Check-In"
          />
        }
      />
      <SettingsRow
        title="Allow connection requests"
        description="Let people who see you checked in ask to connect."
        trailing={
          <Switch
            checked={defaults.nearbyCheckInAllowConnectionRequests}
            onCheckedChange={(checked) =>
              setNearbyCheckIn((current) => ({
                ...current,
                nearbyCheckInAllowConnectionRequests: checked,
              }))
            }
            aria-label="Allow connection requests"
          />
        }
      />
      <SettingsRow
        title="In an emergency"
        description="What a bare phrase like 'save me' or 'SOS' does. Still confirmed before anything sends."
        trailing={
          <Select
            value={defaults.sosDefaultAction}
            onValueChange={(value) =>
              setSosDefault(value as OneLocationSosVoiceDefaultAction)
            }
          >
            <SelectTrigger
              className="w-full sm:w-56 min-w-[11rem]"
              aria-label="In an emergency"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open the screen</SelectItem>
              <SelectItem value="trigger">Send the alert</SelectItem>
            </SelectContent>
          </Select>
        }
        stackTrailingOnMobile
      />
    </SettingsGroup>
  );
}

function ConnectAgentDefaultsGroup({
  getIdToken,
}: {
  getIdToken: (() => Promise<string>) | null;
}) {
  const [shareScopes, setShareScopes] = useState<boolean | null>(null);

  useEffect(() => {
    if (!getIdToken) return;
    let cancelled = false;
    getIdToken()
      .then((idToken) => ConnectionsService.getVoicePreferences({ idToken }))
      .then((preferences) => {
        if (!cancelled) setShareScopes(preferences.shareScopesFromLastRequest);
      })
      .catch(() => {
        // Settings row disappears rather than showing a stale or wrong
        // default; the person can reopen the page to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [getIdToken]);

  if (!getIdToken || shareScopes === null) return null;

  return (
    <SettingsGroup
      title="Connect"
      description="Defaults One uses for voice-initiated connection requests."
    >
      <SettingsRow
        title="Reuse scopes from last request"
        description="Let a repeat voice request offer the same access as last time. The other person still approves every request."
        trailing={
          <Switch
            checked={shareScopes}
            onCheckedChange={(checked) => {
              setShareScopes(checked);
              getIdToken()
                .then((idToken) =>
                  ConnectionsService.updateVoicePreferences({
                    idToken,
                    shareScopesFromLastRequest: checked,
                  }),
                )
                .catch(() => setShareScopes(!checked));
            }}
            aria-label="Reuse scopes from last request"
          />
        }
      />
    </SettingsGroup>
  );
}

export function VoicePreferencesPanel({
  userId,
  vaultOwnerToken = null,
  getIdToken = null,
  onOpenChangelog,
  onOpenExamples,
}: {
  userId: string | null;
  vaultOwnerToken?: string | null;
  getIdToken?: (() => Promise<string>) | null;
  onOpenChangelog: () => void;
  onOpenExamples: () => void;
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
      <SettingsGroup>
        <SettingsRow
          title="What can I say"
          description="Examples for every part of the app."
          chevron
          onClick={onOpenExamples}
        />
      </SettingsGroup>
      <VoiceChangelog onOpenChangelog={onOpenChangelog} />
      <SettingsGroup>
        <SettingsRow
          title="Voice control"
          description="Let One act on what you say."
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
        <SettingsRow
          title="Voice"
          description="Pick who One sounds like."
          disabled={!state.voiceEnabled}
          trailing={
            <Select
              value={state.voiceName ?? VOICE_NAME_DEFAULT_VALUE}
              disabled={!state.voiceEnabled}
              onValueChange={(value) =>
                set((current) => ({
                  ...current,
                  voiceName: value === VOICE_NAME_DEFAULT_VALUE ? null : value,
                }))
              }
            >
              <SelectTrigger
                className="w-full sm:w-60 min-w-[11rem]"
                aria-label="Voice"
              >
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={VOICE_NAME_DEFAULT_VALUE}>
                  Default
                </SelectItem>
                {VOICE_PERSONA_OPTIONS.map((option) => (
                  <SelectItem key={option.name} value={option.name}>
                    {option.name} — {option.descriptor}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          stackTrailingOnMobile
        />
      </SettingsGroup>
      <SettingsGroup title="Safety" description="For actions that already ask to confirm.">
        <SettingsRow
          title="Require a tap to confirm"
          description="Stops a spoken yes or no from confirming."
          disabled={!state.voiceEnabled}
          trailing={
            <Switch
              checked={state.requireTapConfirmation}
              disabled={!state.voiceEnabled}
              onCheckedChange={(checked) =>
                set((current) => ({ ...current, requireTapConfirmation: checked }))
              }
              aria-label="Require a tap to confirm"
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Guidance" description="See each step as One works.">
        <SettingsRow
          title="Walk-through mode"
          description="Follow along step by step."
          disabled={!state.voiceEnabled}
          trailing={
            <Switch
              checked={state.walkthroughMode}
              disabled={!state.voiceEnabled}
              onCheckedChange={(checked) =>
                set((current) => ({ ...current, walkthroughMode: checked }))
              }
              aria-label="Walk-through mode"
            />
          }
        />
      </SettingsGroup>
      <LocationAgentDefaultsGroup vaultOwnerToken={vaultOwnerToken} />
      <ConnectAgentDefaultsGroup getIdToken={getIdToken} />
      <SettingsGroup
        title="What voice can control"
        description="Turn a domain off to block voice there; tap still works."
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
