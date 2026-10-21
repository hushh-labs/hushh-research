"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import {
  ProfilePaneInviteIcon,
  ProfilePaneSearchIcon,
} from "@/components/profile/profile-pane-icons";
import { HelperText } from "@/components/app-ui/typography";
import { Switch } from "@/components/ui/switch";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { WorldModelInvitations } from "@/components/profile/world-model-invitations";
import { WorldModelSources } from "@/components/profile/world-model-sources";
import type { PwmPreferences } from "@/lib/services/world-model-research-service";

type Sheet = "invite" | "sources" | "research";

/** Secondary Personal World Model actions, each in its own sheet. */
export function WorldModelOptions({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  name,
  usable,
  failed,
  preferences,
  sourcesRequest,
  canCheckForUpdates,
  canResearchPublicProfiles,
  pathname,
  embedded,
  present,
  backQuery,
  onSourcesSaved,
  onUpdatePreferences,
  onCheckForUpdates,
  onResearchPublicProfiles,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  name: string;
  /** Only inviting waits for a model worth sharing. */
  usable: boolean;
  /** Preparing failed: the switches stay reachable even before they are read. */
  failed: boolean;
  preferences: PwmPreferences | null;
  /** Bumped after a claim moves the inviter's preview into these sources. */
  sourcesRequest: number;
  canCheckForUpdates: boolean;
  canResearchPublicProfiles: boolean;
  pathname: string;
  embedded: boolean;
  present: boolean;
  backQuery?: Readonly<Record<string, string>>;
  onSourcesSaved: () => void;
  onUpdatePreferences: (value: Pick<PwmPreferences, "enabled" | "email_enabled">) => Promise<void>;
  onCheckForUpdates: () => void;
  onResearchPublicProfiles: (urls: readonly string[]) => void;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const azureResearch = preferences?.research_provider === "azure_openai_web_search";
  const open = sheet !== null && (sheet !== "invite" || usable);
  const close = useCallback(() => {
    setSheet(null);
    setSaveFailed(false);
    return true;
  }, []);
  useBackLayer(pathname, present && open ? 1 : 0, close, backQuery);
  // Show a just-claimed preview at once; a remount (token renewal) never reopens it.
  const shownSources = useRef(sourcesRequest);
  useEffect(() => {
    if (shownSources.current === sourcesRequest) return;
    shownSources.current = sourcesRequest;
    setSaveFailed(false);
    setSheet("sources");
  }, [sourcesRequest]);

  async function update(value: Pick<PwmPreferences, "enabled" | "email_enabled">) {
    if (busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      await onUpdatePreferences(value);
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsGroup density="compact">
        <SettingsRow icon={ProfilePaneSearchIcon} iconTone="capability" title="Add a public source"
          chevron voiceControlId="pwm_public_sources_open" onClick={() => setSheet("sources")} />
        {usable ? (
          <SettingsRow
            icon={ProfilePaneInviteIcon}
            iconTone="capability"
            title="Invite someone"
            chevron
            voiceControlId="pwm_invite_open"
            onClick={() => setSheet("invite")}
          />
        ) : null}
        {preferences || failed ? (
          <SettingsRow
            icon={ProfilePaneSearchIcon}
            iconTone="capability"
            title="Research and email"
            chevron
            voiceControlId="pwm_settings_open"
            onClick={() => setSheet("research")}
          />
        ) : null}
      </SettingsGroup>
      <SettingsDetailPanel
        open={open && sheet === "invite"}
        onOpenChange={(next) => void (!next && close())}
        title="Invite someone"
      >
        <WorldModelInvitations
          key={`${ownerId}:${vaultOwnerToken}`}
          ownerId={ownerId}
          vaultKey={vaultKey}
          vaultOwnerToken={vaultOwnerToken}
        />
      </SettingsDetailPanel>
      <SettingsDetailPanel
        open={open && sheet === "sources"}
        onOpenChange={(next) => void (!next && close())}
        title="Add a public source"
      >
        <WorldModelSources
          key={`${ownerId}:${vaultOwnerToken}:${sourcesRequest}`}
          ownerId={ownerId}
          vaultKey={vaultKey}
          vaultOwnerToken={vaultOwnerToken}
          name={name}
          embedded={embedded}
          present={present && open && sheet === "sources"}
          backQuery={backQuery}
          onSaved={onSourcesSaved}
          onResearchPublicProfiles={azureResearch && preferences?.enabled && canResearchPublicProfiles ? urls => {
            if (!present) return;
            onResearchPublicProfiles(urls);
            close();
          } : undefined}
        />
      </SettingsDetailPanel>
      <SettingsDetailPanel
        open={open && sheet === "research"}
        onOpenChange={(next) => void (!next && close())}
        title="Research and email"
        mobilePresentation="sheet"
      >
        {preferences ? (
          <SettingsGroup density="compact">
            <SettingsRow
              title="Research public pages"
              description={azureResearch
                ? "Turning this on lets GPT-5 mini on Microsoft Azure AI plan searches and prepare your draft from public pages. Bing may receive your name and verified email or phone in search terms outside Azure's compliance and data residency boundary. You review findings before saving."
                : "Uses your name and verified email or phone to find pages about you with Google Search through Vertex AI."}
              trailing={
                <span className="inline-flex h-11 items-center">
                  <Switch
                    checked={preferences.enabled}
                    disabled={busy}
                    aria-label="Research public pages"
                    data-voice-control-id="pwm_research_enabled"
                    onCheckedChange={(checked) =>
                      void update({
                        enabled: checked,
                        email_enabled: preferences.email_enabled,
                      })
                    }
                  />
                </span>
              }
            />
            <SettingsRow
              title="Email me when it’s ready"
              trailing={
                <span className="inline-flex h-11 items-center">
                  <Switch
                    checked={preferences.email_enabled}
                    disabled={busy}
                    aria-label="Email me when it’s ready"
                    data-voice-control-id="pwm_email"
                    onCheckedChange={(checked) =>
                      void update({
                        enabled: preferences.enabled,
                        email_enabled: checked,
                      })
                    }
                  />
                </span>
              }
            />
            {preferences.enabled && canCheckForUpdates ? (
              <SettingsRow
                title="Check for updates"
                description="Look at public pages again now."
                disabled={busy}
                chevron
                voiceControlId="pwm_refresh"
                onClick={() => {
                  onCheckForUpdates();
                  close();
                }}
              />
            ) : null}
          </SettingsGroup>
        ) : (
          <HelperText role="status" className="profile-account-note">
            Checking your settings…
          </HelperText>
        )}
        {saveFailed ? (
          <HelperText role="alert" className="profile-account-note">
            Couldn’t save. Try again.
          </HelperText>
        ) : null}
      </SettingsDetailPanel>
    </>
  );
}
