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
import { VOICE_ENGINE_DOMAINS } from "@/lib/agent/voice-engine-domains";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationSosVoiceDefaultAction } from "@/lib/one-location/types";
import { ConnectionsService } from "@/lib/services/connections-service";

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
        Location commands
      </PageSubtitle>
    </div>
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
      {/*
        The old copy said the setting lets a repeat request "offer the same
        access as last time". It does more than offer: connect.send_request
        reuses BOTH offeredScopeHandles and requestedScopeHandles, so it also
        ASKS for the same access again. On a consent control that asymmetry is
        the whole point -- somebody reading "offer" reasonably concludes this
        only affects what they give away, not what they request.

        "last time" was also vaguer than the behaviour. Scopes come from this
        requester's most recent request to THIS exact person; there is
        deliberately no wider "usual scopes" fallback, so a repeat can never
        extrapolate from someone else and a first request is always empty.
        That narrowness is reassuring, and the copy was hiding it.

        "Scopes" is our word, not a person's. The row says access instead.
      */}
      <SettingsRow
        title="Reuse access from last time"
        description="A repeat voice request asks for and offers the same access you did with that person before. They still approve every request."
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
            aria-label="Reuse access from last time"
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
}: {
  userId: string | null;
  vaultOwnerToken?: string | null;
  getIdToken?: (() => Promise<string>) | null;
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
      <SettingsGroup title="How commands work">
        <SettingsRow
          title="Use your own words"
          description="Hold Talk to One, speak, and release. One interprets the request from your current Location context, then executes it, asks for a required action, or opens the relevant screen."
        />
      </SettingsGroup>
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
      </SettingsGroup>
      <SettingsGroup title="Confirmations">
        <SettingsRow title="Confirm sensitive actions" description="Location commands show a card when an action requires your approval. Tap Confirm to continue." />
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
