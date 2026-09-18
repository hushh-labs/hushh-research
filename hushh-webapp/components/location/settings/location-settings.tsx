"use client";

/**
 * `/one/location?action=settings` for the voice-first Location area.
 *
 * Every control calls the same endpoint its voice tool calls, so the screen
 * and the spoken answer can never disagree:
 *   - Sharing with people  -> PATCH /account-settings {sharingState}   (turn_sharing_on/off)
 *   - Precision            -> PATCH /account-settings {precision}      (set_precision)
 *   - Hidden on the map    -> PATCH /map-preferences {presenceMode}    (hide_on_map/show_on_map)
 *   - Auto-approve         -> PATCH /auto-approve-preference           (set_auto_approve)
 *   - Nearby defaults      -> PATCH /nearby-check-in-preferences
 *
 * The header follows the Location header contract: eyebrow "Location",
 * title "Settings" (the breadcrumb label), no in-content back control.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SectionLabel, TrailingValue } from "@/components/app-ui/typography";
import {
  ConsentRequiredNotice,
  TurnOffSharingDialog,
  useSharingPostureControls,
  type LocationPrecisionFact,
} from "@/components/location/location-status-card";
import {
  useLocationVoiceReconcile,
  useLocationWorkspaceState,
} from "@/components/location/location-home";
import { Switch } from "@/components/ui/switch";
import { useLocationAccountSettings } from "@/lib/location/account-settings";
import {
  LOCATION_VOICE_SCREEN_IDS,
  hrefForLocationAction,
} from "@/lib/location/screen-ids";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { TaskFlowHeader } from "@/lib/morphy-ux/ui/surface-primitives";
import { ROUTES } from "@/lib/navigation/routes";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  AutoApproveScope,
  OneLocationCircleSummary,
  OneLocationMapPreferences,
} from "@/lib/one-location/types";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { useVault } from "@/lib/vault/vault-context";

const GROUP_SHELL = "[--settings-group-radius:16px] shadow-none";
const ROW_CLASS = "[--settings-row-px:16px] [--settings-row-py:14px]";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="w-full">
      <SectionLabel as="p" compact className="mb-2 px-[6px]">
        {title}
      </SectionLabel>
      {children}
    </section>
  );
}

function ownedCircles(
  circles: readonly OneLocationCircleSummary[] | undefined,
) {
  return (circles ?? []).filter(
    (circle) => circle.role === "owner" && circle.systemKind !== "trusted",
  );
}

function scopeLabel(
  scope: AutoApproveScope | null | undefined,
  circles: readonly OneLocationCircleSummary[],
): string {
  if (!scope) return "All contacts";
  if (scope.kind === "all_contacts") return "All contacts";
  const ids = scope.kind === "circle" ? [scope.circleId] : scope.circleIds;
  const names = ids
    .map((id) => circles.find((circle) => circle.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  if (!names.length)
    return `${ids.length} ${ids.length === 1 ? "circle" : "circles"}`;
  if (names.length <= 2) return names.join(" and ");
  return `${names.length} circles`;
}

const PRECISION_OPTIONS = [
  { value: "precise", label: "Precise" },
  { value: "approximate", label: "Approximate" },
];

export function LocationSettings() {
  const router = useRouter();
  const { vaultOwnerToken } = useVault();
  const account = useLocationAccountSettings();
  const workspace = useLocationWorkspaceState();

  const settings = account.settings;
  const sharingState = settings?.sharing_state ?? "unset";
  const precision: LocationPrecisionFact =
    settings?.precision === "approximate" ? "approximate" : "precise";

  const controls = useSharingPostureControls();

  /* ---- map presence (ghost mode) ---- */
  const [mapPreferences, setMapPreferences] =
    useState<OneLocationMapPreferences | null>(null);
  const [mapBusy, setMapBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadMapPreferences = useCallback(async () => {
    if (!vaultOwnerToken) return;
    try {
      const next = await OneLocationService.getMapPreferences(vaultOwnerToken);
      if (mountedRef.current) setMapPreferences(next);
    } catch {
      // The row shows "Unknown" until a later read succeeds.
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    void loadMapPreferences();
  }, [loadMapPreferences]);

  useLocationVoiceReconcile({
    onSettings: () => {
      void account.refresh();
      void loadMapPreferences();
    },
  });

  const setHidden = useCallback(
    async (hidden: boolean) => {
      if (!vaultOwnerToken) return;
      setMapBusy(true);
      try {
        const next = await OneLocationService.updateMapPreferences({
          vaultOwnerToken,
          presenceMode: hidden ? "ghost" : "foreground_private",
        });
        if (mountedRef.current) setMapPreferences(next);
        morphyToast.success(
          hidden ? "You're hidden on the map." : "You're visible on the map.",
        );
      } catch (error) {
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "Map visibility could not be saved.",
        );
      } finally {
        if (mountedRef.current) setMapBusy(false);
      }
    },
    [vaultOwnerToken],
  );

  /* ---- auto-approve ---- */
  const circles = useMemo(
    () => ownedCircles(workspace.state?.circles),
    [workspace.state?.circles],
  );
  const autoApprove = workspace.state?.autoApprovePreference ?? null;
  const [autoBusy, setAutoBusy] = useState(false);

  const setAutoApprove = useCallback(
    async (enabled: boolean, scope: AutoApproveScope | null) => {
      if (!vaultOwnerToken || !workspace.userId) return;
      setAutoBusy(true);
      try {
        const preference = await OneLocationService.updateAutoApprovePreference(
          {
            vaultOwnerToken,
            enabled,
            scope: enabled ? (scope ?? { kind: "all_contacts" }) : null,
          },
        );
        const current = OneLocationStateResource.readPresentation(
          workspace.userId,
        );
        if (current) {
          OneLocationStateResource.invalidate(workspace.userId);
          OneLocationStateResource.write(workspace.userId, {
            ...current,
            autoApprovePreference: preference,
          });
        }
        await workspace.refresh({ invalidate: true });
        morphyToast.success(
          enabled ? "Automatic approval is on." : "Automatic approval is off.",
        );
      } catch (error) {
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "Automatic approval could not be saved.",
        );
      } finally {
        if (mountedRef.current) setAutoBusy(false);
      }
    },
    [vaultOwnerToken, workspace],
  );

  /* ---- nearby check-in defaults ---- */
  const nearby = workspace.state?.nearbyCheckInPreferences ?? null;
  const [nearbyBusy, setNearbyBusy] = useState(false);

  const setNearby = useCallback(
    async (patch: { visible?: boolean; allowConnectionRequests?: boolean }) => {
      if (!vaultOwnerToken || !workspace.userId) return;
      setNearbyBusy(true);
      try {
        const preferences =
          await OneLocationService.updateNearbyCheckInPreferences({
            vaultOwnerToken,
            visible: patch.visible ?? nearby?.visible ?? false,
            allowConnectionRequests:
              patch.allowConnectionRequests ??
              nearby?.allowConnectionRequests ??
              false,
          });
        const current = OneLocationStateResource.readPresentation(
          workspace.userId,
        );
        if (current) {
          OneLocationStateResource.invalidate(workspace.userId);
          OneLocationStateResource.write(workspace.userId, {
            ...current,
            nearbyCheckInPreferences: preferences,
          });
        }
        await workspace.refresh({ invalidate: true });
      } catch (error) {
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "Nearby check-in defaults could not be saved.",
        );
      } finally {
        if (mountedRef.current) setNearbyBusy(false);
      }
    },
    [
      nearby?.allowConnectionRequests,
      nearby?.visible,
      vaultOwnerToken,
      workspace,
    ],
  );

  const hidden = mapPreferences
    ? mapPreferences.presenceMode === "ghost"
    : null;
  const loading = account.status === "loading" && !settings;

  usePublishVoiceSurfaceMetadata(
    useMemo(
      () => ({
        screenId: LOCATION_VOICE_SCREEN_IDS.settings,
        title: "Location settings",
        purpose:
          "Sharing on or off, precision, map visibility, automatic approval, and nearby check-in defaults.",
        spokenSubject: "Location settings",
        screenState: {
          sharing_state: sharingState,
          precision,
          hidden_on_map: hidden,
          auto_approve: Boolean(autoApprove?.enabled),
          nearby_visible: nearby ? nearby.visible : null,
        },
      }),
      [autoApprove?.enabled, hidden, nearby, precision, sharingState],
    ),
  );

  return (
    <div
      className="mx-auto w-full max-w-[640px] space-y-6 pb-[max(20px,env(safe-area-inset-bottom))]"
      data-testid="location-settings"
    >
      <TaskFlowHeader eyebrow="Location" title="Settings" />

      <Section title="Sharing">
        <SettingsGroup embedded separatorInset shellClassName={GROUP_SHELL}>
          <SettingsRow
            title="Sharing with people"
            description={
              loading
                ? "Loading"
                : sharingState === "unset"
                  ? "Not set up. Finish Location setup to turn sharing on."
                  : sharingState === "on"
                    ? "On. People you share with can see you."
                    : "Off. No one can see your location."
            }
            trailing={
              sharingState === "unset" ? (
                <TrailingValue as="span">Not set up</TrailingValue>
              ) : (
                <Switch
                  size="ios"
                  checked={sharingState === "on"}
                  disabled={loading || controls.disabled}
                  aria-label="Sharing with people"
                  onCheckedChange={(next) => {
                    if (next) void controls.turnOn();
                    else controls.openConfirmOff();
                  }}
                  data-testid="location-settings-sharing-switch"
                />
              )
            }
            trailingInteractive
            onClick={
              sharingState === "unset"
                ? () => router.push(ROUTES.ONE_SETUP_LOCATION)
                : undefined
            }
            chevron={sharingState === "unset"}
            className={ROW_CLASS}
            testId="location-settings-sharing-row"
          />
          <SettingsRow
            title="Precision"
            description={
              precision === "approximate"
                ? "People see an approximate area (~1 km). Save My Soul is always precise."
                : "People see your precise position. Save My Soul is always precise."
            }
            trailing={
              <div className="w-full min-w-[220px] sm:w-[240px]">
                <SegmentedTabs
                  ariaLabel="Precision"
                  value={precision}
                  options={PRECISION_OPTIONS}
                  disabled={
                    loading || controls.disabled || sharingState === "unset"
                  }
                  onValueChange={(next) =>
                    void controls.setPrecision(
                      next === "approximate" ? "approximate" : "precise",
                    )
                  }
                />
              </div>
            }
            trailingInteractive
            stackTrailingOnMobile
            className={ROW_CLASS}
            testId="location-settings-precision-row"
          />
        </SettingsGroup>
        {controls.consentRequired ? (
          <div className="mt-3">
            <ConsentRequiredNotice setupHref={ROUTES.ONE_SETUP_LOCATION} />
          </div>
        ) : null}
      </Section>

      <Section title="Map">
        <SettingsGroup embedded separatorInset shellClassName={GROUP_SHELL}>
          <SettingsRow
            title="Hidden on the map"
            description={
              hidden === null
                ? "Loading"
                : hidden
                  ? "Ghost mode. Your connections can't find you on the map. Private shares still reach the people they were made for."
                  : "Visible. Connections can see you on the map while you share."
            }
            trailing={
              mapBusy ? (
                <Loader2
                  className="h-5 w-5 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <Switch
                  size="ios"
                  checked={hidden === true}
                  disabled={hidden === null || !vaultOwnerToken}
                  aria-label="Hidden on the map"
                  onCheckedChange={(next) => void setHidden(next)}
                  data-testid="location-settings-ghost-switch"
                />
              )
            }
            trailingInteractive
            className={ROW_CLASS}
            testId="location-settings-ghost-row"
          />
        </SettingsGroup>
      </Section>

      <Section title="Automatic approval">
        <SettingsGroup embedded separatorInset shellClassName={GROUP_SHELL}>
          <SettingsRow
            title="Auto-approve requests"
            description={
              !workspace.state
                ? "Loading"
                : autoApprove?.enabled
                  ? `On for ${scopeLabel(autoApprove.scope, circles)}. Requests already waiting still need an answer.`
                  : "Off. Every request waits for your answer."
            }
            trailing={
              autoBusy ? (
                <Loader2
                  className="h-5 w-5 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <Switch
                  size="ios"
                  checked={Boolean(autoApprove?.enabled)}
                  disabled={!workspace.state || !vaultOwnerToken}
                  aria-label="Auto-approve requests"
                  onCheckedChange={(next) =>
                    void setAutoApprove(
                      next,
                      next
                        ? (autoApprove?.scope ?? { kind: "all_contacts" })
                        : null,
                    )
                  }
                  data-testid="location-settings-auto-approve-switch"
                />
              )
            }
            trailingInteractive
            className={ROW_CLASS}
            testId="location-settings-auto-approve-row"
          />
          {autoApprove?.enabled ? (
            <SettingsRow
              title="Who gets approved"
              description="All contacts, or one of the circles you own."
              trailing={
                <select
                  aria-label="Auto-approve scope"
                  className="min-h-11 rounded-[12px] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3 text-[15px] text-[color:var(--app-label)]"
                  disabled={autoBusy || !vaultOwnerToken}
                  value={
                    autoApprove.scope?.kind === "circle"
                      ? `circle:${autoApprove.scope.circleId}`
                      : "all_contacts"
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    const scope: AutoApproveScope = value.startsWith("circle:")
                      ? {
                          kind: "circle",
                          circleId: value.slice("circle:".length),
                        }
                      : { kind: "all_contacts" };
                    void setAutoApprove(true, scope);
                  }}
                  data-testid="location-settings-auto-approve-scope"
                >
                  <option value="all_contacts">All contacts</option>
                  {circles.map((circle) => (
                    <option key={circle.id} value={`circle:${circle.id}`}>
                      {circle.name}
                    </option>
                  ))}
                </select>
              }
              trailingInteractive
              stackTrailingOnMobile
              className={ROW_CLASS}
              testId="location-settings-auto-approve-scope-row"
            />
          ) : null}
        </SettingsGroup>
      </Section>

      <Section title="Nearby check-in">
        <SettingsGroup embedded separatorInset shellClassName={GROUP_SHELL}>
          <SettingsRow
            title="Visible to people at the same place"
            description="Default for a new check-in. You can change it each time."
            trailing={
              <Switch
                size="ios"
                checked={Boolean(nearby?.visible)}
                disabled={!workspace.state || nearbyBusy || !vaultOwnerToken}
                aria-label="Visible to people at the same place"
                onCheckedChange={(next) => void setNearby({ visible: next })}
                data-testid="location-settings-nearby-visible-switch"
              />
            }
            trailingInteractive
            className={ROW_CLASS}
            testId="location-settings-nearby-visible-row"
          />
          <SettingsRow
            title="Allow connection requests"
            description="People checked in nearby can ask to connect."
            trailing={
              <Switch
                size="ios"
                checked={Boolean(nearby?.allowConnectionRequests)}
                disabled={!workspace.state || nearbyBusy || !vaultOwnerToken}
                aria-label="Allow connection requests"
                onCheckedChange={(next) =>
                  void setNearby({ allowConnectionRequests: next })
                }
                data-testid="location-settings-nearby-requests-switch"
              />
            }
            trailingInteractive
            className={ROW_CLASS}
            testId="location-settings-nearby-requests-row"
          />
        </SettingsGroup>
      </Section>

      <Section title="Safety">
        <SettingsGroup embedded separatorInset shellClassName={GROUP_SHELL}>
          <SettingsRow
            title="Emergency contacts"
            description="Who Save My Soul alerts."
            trailing={
              <TrailingValue as="span">
                {workspace.state
                  ? (workspace.state.smsContactUserIds?.length ?? 0)
                  : ""}
              </TrailingValue>
            }
            onClick={() =>
              router.push(hrefForLocationAction("sms-contacts"), {
                scroll: false,
              })
            }
            chevron
            density="compact"
            className="[--settings-row-px:16px]"
            testId="location-settings-emergency-contacts"
          />
          <SettingsRow
            title="Ratings"
            description="Places you've rated."
            onClick={() =>
              router.push(hrefForLocationAction("ratings"), { scroll: false })
            }
            chevron
            density="compact"
            className="[--settings-row-px:16px]"
            testId="location-settings-ratings"
          />
        </SettingsGroup>
      </Section>

      <TurnOffSharingDialog controls={controls} />
    </div>
  );
}
