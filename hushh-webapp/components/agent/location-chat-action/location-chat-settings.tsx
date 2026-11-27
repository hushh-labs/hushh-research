"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FeedPushPromptView, useFeedPushPrompt } from "@/components/feed/feed-push-prompt";
import { captureChatLocation, chatLocationPermissionIssue, LocationChatPermissionRecovery, type ChatLocationPermissionIssue } from "./location-chat-permission";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  getLocationAccountSettings,
  LocationAccountSettingsResource,
  locationSettingsErrorCode,
  updateLocationAccountSettings,
  type LocationAccountSettings,
  type LocationAccountSettingsPatch,
} from "@/lib/location/account-settings";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { readOneLocationControlState, updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { dispatchOneLocationStateChanged } from "@/lib/one-location/one-location-state-events";
import { OneLocationService } from "@/lib/one-location/service";
import type { AutoApproveScope, OneLocationCircleSummary, OneLocationMapPreferences, OneLocationState } from "@/lib/one-location/types";
import { useOneLocationControlState } from "@/lib/one-location/use-location-control-state";
import { publishOneLocationMapPreferences } from "@/lib/one-location/use-one-location-map-preferences";
import { useLocationChatMutation } from "./use-location-chat-mutation";
import { locationChoiceFromReply, locationReviewDecision } from "@/lib/agent/main-chat-location-conversation";
import { useLocationConversationTurn, type LocationConversationProps } from "./use-location-conversation-turn";

const LocationSetupFlow = dynamic(() => import("@/components/location/setup/location-setup-flow").then((module) => module.LocationSetupFlow), {
  loading: () => <p role="status" className="text-sm">Preparing Location setup…</p>,
});

type SettingsView = {
  account: LocationAccountSettings | null;
  map: OneLocationMapPreferences | null;
  state: OneLocationState;
  circles: OneLocationCircleSummary[];
};
type Review = {
  description: string;
  label: string;
  run: (signal: AbortSignal) => Promise<string>;
};

function selectedCircleIds(scope: AutoApproveScope | null | undefined): string[] {
  if (scope?.kind === "circle") return [scope.circleId];
  return scope?.kind === "circles" ? scope.circleIds : [];
}

function sameScope(left: AutoApproveScope | null, right: AutoApproveScope | null): boolean {
  if (!left || !right) return left === right;
  if (left.kind === "all_contacts" || right.kind === "all_contacts") return left.kind === right.kind;
  const a = selectedCircleIds(left);
  const b = selectedCircleIds(right);
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function LocationChatSettings({ token, ownerId, onChanged, autoApprovalIntent, autoApprovalHours, suggestedCircles, onClose, onConversationReply, onConversationText }: {
  token: string;
  ownerId: string;
  onChanged?: () => void;
  autoApprovalIntent?: "enable" | "disable";
  autoApprovalHours?: number;
  suggestedCircles?: readonly string[];
  onClose?: () => void;
} & LocationConversationProps) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [setupOffered, setSetupOffered] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [scopeEditing, setScopeEditing] = useState(false);
  const [scope, setScope] = useState<AutoApproveScope | null>(null);
  const [directReviewDismissed, setDirectReviewDismissed] = useState(false);
  const { busy, error, notice, run } = useLocationChatMutation();
  const { paused } = useOneLocationControlState(ownerId);
  const nearbyAvailable = isOneLocationNearbyCheckInAvailable();
  const pushPrompt = useFeedPushPrompt("location");
  const [permissionIssue, setPermissionIssue] = useState<ChatLocationPermissionIssue>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      autoApprovalIntent ? null : getLocationAccountSettings(token),
      autoApprovalIntent ? null : OneLocationService.getMapPreferences(token),
      OneLocationService.getState(token),
      autoApprovalIntent === "disable" ? [] : OneLocationService.listCircles(token),
    ]).then(([account, map, state, circles]) => {
      if (!active) return;
      if (account?.user_id && account.user_id !== ownerId) throw new Error("Location settings belong to a different account.");
      const eligibleCircles = circles.filter((circle) => circle.role === "owner" && circle.systemKind !== "trusted");
      setView({ account, map, state, circles: eligibleCircles });
      if (autoApprovalIntent === "enable") {
        const matches = (suggestedCircles ?? []).map((name) => eligibleCircles.filter(
          (circle) => circle.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
        ));
        // A partial or ambiguous match must never silently narrow or expand standing consent.
        const circleIds = matches.length && matches.every((choices) => choices.length === 1)
          ? [...new Set(matches.map((choices) => choices[0]!.id))] : [];
        setScope(circleIds.length ? { kind: "circles", circleIds } : null);
        setScopeEditing(!state.autoApprovePreference?.enabled || matches.length > 0);
      }
      setLoadError("");
    }).catch((caught: unknown) => {
      if (active) setLoadError(oneLocationErrorMessage(caught, "Could not load Location settings."));
    });
    return () => { active = false; };
  }, [token, ownerId, reload, autoApprovalIntent, suggestedCircles]);

  const directDisableReview = autoApprovalIntent === "disable" && Boolean(view?.state.autoApprovePreference?.enabled) && !directReviewDismissed;
  const dismissReview = () => {
    setReview(null);
    if (directDisableReview) {
      setDirectReviewDismissed(true);
      onClose?.();
    }
  };
  useBackLayer(ROUTES.HOME, review || directDisableReview || scopeEditing || setupOpen || busy ? 3 : 0, () => {
    if (busy) return true;
    if (review || directDisableReview) dismissReview();
    else if (setupOpen) setSetupOpen(false);
    else if (scopeEditing) setScopeEditing(false);
    else return false;
    return true;
  });

  const askTurnOff = (includeSos: boolean) => {
    setReview({
      description: includeSos
        ? "Save My Soul is active. Turn off Location sharing and stop the emergency share too?"
        : "Turn off Location sharing? It ends active shares and links, and recipients are notified.",
      label: includeSos ? "Turn off including Save My Soul" : "Turn off",
      run: (signal) => patchAccount({ sharingState: "off", includeSos }, signal),
    });
  };

  const patchAccount = async (patch: LocationAccountSettingsPatch, signal: AbortSignal) => {
    try {
      signal.throwIfAborted();
      const { settings, transition } = await updateLocationAccountSettings(token, patch);
      if (signal.aborted) return "";
      if (settings.user_id && settings.user_id !== ownerId) throw new Error("Location settings belong to a different account.");
      LocationAccountSettingsResource.write(ownerId, settings);
      setView((current) => current && { ...current, account: settings });
      if (patch.sharingState && patch.sharingState !== settings.sharingState) throw new Error("The sharing setting did not change.");
      if (patch.precision && patch.precision !== settings.precision) throw new Error("The precision setting did not change.");
      if (transition?.changed) CacheSyncService.onOneLocationStateMutated(ownerId, ["workspace"]);
      onChanged?.();
      if (patch.precision) return settings.precision === "precise" ? "Sharing precision is precise." : "Sharing precision is approximate.";
      if (settings.sharingState === "on") return "Location sharing is on.";
      const ended = (transition?.revoked_grant_ids.length ?? 0) + (transition?.revoked_link_ids.length ?? 0);
      return ended ? `Location sharing is off. ${ended} active shares and links ended.` : "Location sharing is off.";
    } catch (caught) {
      if (signal.aborted) return "";
      const code = locationSettingsErrorCode(caught);
      if (code === "LOCATION_SHARING_CONSENT_REQUIRED") {
        setSetupOffered(true);
        return "";
      }
      if (code === "LOCATION_SOS_ACTIVE" && patch.sharingState === "off" && !patch.includeSos) {
        askTurnOff(true);
        return "";
      }
      throw caught;
    }
  };

  const askPrecision = () => {
    if (!view?.account) return;
    const precision = view.account.precision === "precise" ? "approximate" : "precise";
    setReview({
      description: `Set Location sharing precision to ${precision}?`,
      label: "Change precision",
      run: (signal) => patchAccount({ precision }, signal),
    });
  };

  const askDevicePause = () => {
    setReview({
      description: nearbyAvailable
        ? "Pause updates from this device and end your Nearby check-in? Existing shares will keep their current access."
        : "Pause updates from this device? Existing shares will keep their current access.",
      label: "Pause updates",
      run: async (signal) => {
        signal.throwIfAborted();
        updateOneLocationControlState(ownerId, (current) => ({ ...current, paused: true }));
        if (nearbyAvailable) {
          try { await OneLocationService.checkoutNearby({ vaultOwnerToken: token }); }
          catch {
            if (signal.aborted) return "";
            throw new Error("Device updates are paused. Nearby checkout could not be confirmed. You may still be visible in Nearby.");
          }
        }
        if (signal.aborted) return "";
        if (!readOneLocationControlState(ownerId).paused) throw new Error("A newer device location change replaced this pause.");
        onChanged?.();
        return "Location updates are paused on this device.";
      },
    });
  };

  const askDeviceResume = () => {
    setPermissionIssue(null);
    setReview({
      description: "Resume updates from this device? This can restart any active shares, including Save My Soul. Your account sharing setting stays as you chose it.",
      label: "Resume updates",
      run: async (signal) => {
        signal.throwIfAborted();
        try { await captureChatLocation(); }
        catch (caught) {
          if (!signal.aborted) setPermissionIssue(chatLocationPermissionIssue(caught));
          throw caught;
        }
        signal.throwIfAborted();
        updateOneLocationControlState(ownerId, (current) => ({ ...current, paused: false }));
        onChanged?.();
        return "Location updates are resumed on this device.";
      },
    });
  };

  const askGhost = () => {
    if (!view?.map) return;
    const presenceMode = view.map.presenceMode === "ghost" ? "foreground_private" : "ghost";
    setReview({
      description: presenceMode === "ghost"
        ? "Turn on Ghost Mode? Existing private shares keep their current access."
        : "Turn off Ghost Mode? People you share with can see you on their map.",
      label: presenceMode === "ghost" ? "Turn on Ghost Mode" : "Turn off Ghost Mode",
      run: async (signal) => {
        signal.throwIfAborted();
        const map = await OneLocationService.updateMapPreferences({ vaultOwnerToken: token, presenceMode });
        if (signal.aborted) return "";
        publishOneLocationMapPreferences(ownerId, map);
        setView((current) => current && { ...current, map });
        if (map.presenceMode !== presenceMode) throw new Error("Ghost Mode did not change.");
        onChanged?.();
        return map.presenceMode === "ghost" ? "Ghost Mode is on." : "Ghost Mode is off.";
      },
    });
  };

  const autoApprovalReview = (next: AutoApproveScope | null): Review | null => {
    if (!view) return null;
    const enabled = next !== null;
    const circleNames = view.circles.filter((circle) => selectedCircleIds(next).includes(circle.id)).map((circle) => circle.name);
    const scopeLabel = next?.kind === "all_contacts" ? "all contacts" : circleNames.join(", ");
    const windowHours = enabled ? autoApprovalHours : undefined;
    const windowLabel = windowHours === undefined ? "until you turn this off" : `for the next ${formatLocationDurationLabel(windowHours)}`;
    return {
      description: enabled
        ? `Automatically approve new requests from ${scopeLabel} ${windowLabel}? ${windowHours === undefined ? "Requests already waiting still need your answer." : "Every automatically approved share ends by then."}`
        : "Turn off automatic approval? Each new request will need your answer.",
      label: enabled ? "Save approval scope" : "Turn off auto-approval",
      run: async (signal) => {
        const refreshed = await OneLocationService.getState(token);
        signal.throwIfAborted();
        const expectedVersion = view.state.autoApprovePreference?.ruleVersion ?? 0;
        const currentVersion = refreshed.autoApprovePreference?.ruleVersion ?? 0;
        if (expectedVersion !== currentVersion) {
          setView((current) => current && { ...current, state: refreshed });
          setDirectReviewDismissed(true);
          setScopeEditing(false);
          throw new Error("Automatic approval changed. Review the current rule before saving.");
        }
        const preference = await OneLocationService.updateAutoApprovePreference({
          vaultOwnerToken: token, enabled, scope: next, ...(windowHours !== undefined ? { durationHours: windowHours } : {}),
        });
        if (signal.aborted) return "";
        OneLocationStateResource.mergeAutoApprovePreference(ownerId, preference, refreshed);
        dispatchOneLocationStateChanged(ownerId, ["workspace"], { notificationType: "location_settings_changed" });
        setView((current) => current && { ...current, state: { ...current.state, autoApprovePreference: preference } });
        if (preference.ruleVersion < currentVersion || preference.enabled !== enabled || !sameScope(preference.scope, next)) throw new Error("Automatic approval did not change as reviewed.");
        onChanged?.();
        setScopeEditing(false);
        if (windowHours !== undefined) {
          const start = Date.parse(preference.enabledAt ?? "");
          const end = Date.parse(preference.expiresAt ?? "");
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || Math.abs(end - start - windowHours * 3_600_000) > 1) {
            throw new Error("I couldn’t verify the automatic approval deadline.");
          }
          return `Automatic approval is on for ${scopeLabel} until ${new Date(end).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}. Shares approved under this rule end by then.`;
        }
        return enabled ? "Automatic approval is on for the selected scope." : "Automatic approval is off.";
      },
    };
  };

  if (autoApprovalIntent && onConversationText) {
    const choices = (view?.circles ?? []).map(({ id, name }) => ({ label: name, circleId: id }));
    const review = autoApprovalIntent === "enable" && scope ? autoApprovalReview(scope)
      : directDisableReview ? autoApprovalReview(null) : null;
    return <AutomaticApprovalConversation
      onConversationReply={onConversationReply} onConversationText={onConversationText}
      choices={choices} review={review} error={loadError || error} notice={notice} busy={busy}
      loaded={Boolean(view)} alreadyOff={Boolean(view) && autoApprovalIntent === "disable" && !view?.state.autoApprovePreference?.enabled}
      chooseScope={setScope}
      commit={(decision) => { void run(decision.run, "I couldn’t verify the change to automatic approval."); }} />;
  }
  if (setupOpen) return <LocationSetupFlow mode="setup" onSetupSkip={() => setSetupOpen(false)} onSetupComplete={() => {
    setSetupOffered(false);
    setSetupOpen(false);
    setReload((value) => value + 1);
    onChanged?.();
  }} />;

  const autoApproval = view?.state.autoApprovePreference;
  const autoOn = Boolean(autoApproval?.enabled && (!autoApproval.expiresAt || Date.parse(autoApproval.expiresAt) > Date.now()));
  const activeCircleNames = view?.circles.filter((circle) => selectedCircleIds(autoApproval?.scope).includes(circle.id)).map((circle) => circle.name) ?? [];
  const visibleReview = review ?? (directDisableReview ? autoApprovalReview(null) : null);

  return <div className="space-y-4" aria-busy={busy || undefined}>
    {!autoApprovalIntent && <section aria-label="Location notifications" className="space-y-2">
      <h4 className="text-sm font-medium">Location notifications</h4>
      {pushPrompt ? <FeedPushPromptView model={pushPrompt} /> :
        <p className="text-sm text-muted-foreground">Location shares, requests and Save My Soul alerts follow your device notification settings.</p>}
    </section>}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {loadError ? <div className="space-y-2">
      <p role="alert" className="text-sm">{loadError}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setReload((value) => value + 1)}>Retry</Button>
    </div> : null}
    {!view && !loadError ? <p role="status" className="text-sm">Getting Location settings…</p> : null}
    {visibleReview ? <div className="space-y-3 rounded-lg border p-3">
      <p className="text-sm">{visibleReview.description}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => {
          const reviewed = visibleReview;
          setReview(null);
          void run(reviewed.run, "Could not verify the setting. Refresh before trying again.");
        }}>{visibleReview.label}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={dismissReview}>Cancel</Button>
      </div>
    </div> : null}
    {!autoApprovalIntent && !review ? <section aria-label="Device location updates" className="space-y-2 border-t pt-3">
      <h4 className="text-sm font-medium">Device location updates</h4>
      {paused ? <p className="text-sm text-muted-foreground">Paused on this device.</p> : null}
      {paused ? <Button size="sm" variant="outline" disabled={busy} onClick={askDeviceResume}>Resume updates</Button> : null}
      <LocationChatPermissionRecovery issue={permissionIssue} />
      {!paused || nearbyAvailable ? <Button size="sm" variant="outline" disabled={busy} onClick={askDevicePause}>
        {paused ? "Check Nearby checkout" : "Pause updates"}
      </Button> : null}
    </section> : null}
    {!visibleReview && !loadError && view ? <>
      {view.account && view.map && <>
      <section aria-label="Location sharing" className="space-y-2">
        <h4 className="text-sm font-medium">Location sharing</h4>
        <p className="text-sm text-muted-foreground">
          {view.account.sharingState === "on" ? "On" : view.account.sharingState === "off" ? "Off" : "Setup needed"} · {view.account.precision === "precise" ? "Precise" : "Approximate"}
        </p>
        <div className="flex flex-wrap gap-2">
          {view.account.sharingState === "on" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => askTurnOff(false)}>Turn off sharing</Button>
          ) : setupOffered || !view.account.sharingConsentAcceptedAt ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setSetupOpen(true)}>Review Location setup</Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run((signal) => patchAccount({ sharingState: "on" }, signal), "Could not verify that sharing turned on.")}>Turn on sharing</Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={askPrecision}>
            Use {view.account.precision === "precise" ? "approximate" : "precise"} location
          </Button>
        </div>
      </section>
      <section aria-label="Ghost Mode" className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-medium">Ghost Mode</h4>
        <p className="text-sm text-muted-foreground">{view.map.presenceMode === "ghost" ? "On" : "Off"}</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={askGhost}>Turn {view.map.presenceMode === "ghost" ? "off" : "on"} Ghost Mode</Button>
      </section>
      </>}
      <section aria-label="Auto-approve Location requests" className="space-y-2">
        <h4 className="text-sm font-medium">Auto-approve requests</h4>
        <p className="text-sm text-muted-foreground">{autoOn
          ? autoApproval?.scope?.kind === "all_contacts" ? "On for all contacts" : activeCircleNames.length ? `On for ${activeCircleNames.join(", ")}` : "On · Choose a new scope"
          : "Off"}{autoOn && autoApproval?.expiresAt ? ` until ${new Date(autoApproval.expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}</p>
        {scopeEditing ? <fieldset disabled={busy} className="space-y-2">
          <legend className="text-sm font-medium">Who can be auto-approved?</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={scope?.kind === "all_contacts"}
              onChange={(event) => setScope(event.target.checked ? { kind: "all_contacts" } : null)} />
            All contacts
          </label>
          <div className="max-h-48 space-y-2 overflow-auto">
            {view.circles.map((circle) => <label key={circle.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selectedCircleIds(scope).includes(circle.id)} onChange={(event) => {
                const ids = selectedCircleIds(scope);
                const next = event.target.checked ? [...ids, circle.id] : ids.filter((id) => id !== circle.id);
                setScope(next.length ? { kind: "circles", circleIds: next } : null);
              }} />
              {circle.name}
            </label>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!scope || busy} onClick={() => scope && setReview(autoApprovalReview(scope))}>Review scope</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setScopeEditing(false)}>Cancel</Button>
          </div>
        </fieldset> : <div className="flex flex-wrap gap-2">
          {autoApprovalIntent !== "disable" && <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            const current = autoApproval?.scope;
            const validIds = selectedCircleIds(current).filter((id) => view.circles.some((circle) => circle.id === id));
            setScope(current?.kind === "all_contacts" ? current : validIds.length ? { kind: "circles", circleIds: validIds } : null);
            setScopeEditing(true);
          }}>Choose approval scope</Button>}
          {autoOn && autoApprovalIntent !== "enable" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setReview(autoApprovalReview(null))}>Turn off auto-approval</Button> : null}
        </div>}
      </section>
    </> : null}
  </div>;
}

function AutomaticApprovalConversation({
  onConversationReply, onConversationText, choices, review, error, notice, loaded, alreadyOff, busy, chooseScope, commit,
}: LocationConversationProps & {
  choices: { label: string; circleId: string }[];
  review: Review | null; error: string; notice: string; loaded: boolean; alreadyOff: boolean; busy: boolean;
  chooseScope: (scope: AutoApproveScope) => void; commit: (review: Review) => void;
}) {
  const [cancelled, setCancelled] = useState(false);
  const question = review ? `${review.description} Reply yes to confirm.`
    : ["Whose location requests should I automatically approve? Type a Circle name or “all contacts”.",
      ...choices.map((choice, index) => `${index + 1}. ${choice.label}`)].join("\n");
  const text = cancelled ? "Cancelled. Your automatic approval settings are unchanged." : notice ||
    (error ? `${error} Ask me to review the setting again.` : busy ? "Updating automatic approval…" :
      !loaded ? "Checking your automatic approval settings…" : alreadyOff ? "Automatic approval is already off." : question);
  useLocationConversationTurn({ onConversationReply, onConversationText }, text, (reply) => {
    if (cancelled || notice || error || alreadyOff || busy) return false;
    const decision = locationReviewDecision(reply);
    if (decision === "cancel") { setCancelled(true); return true; }
    if (!loaded) return false;
    if (review && decision === "confirm") { commit(review); return true; }
    if (reply.trim().toLowerCase() === "all contacts") { chooseScope({ kind: "all_contacts" }); return true; }
    const choice = locationChoiceFromReply(reply, choices);
    if (!choice?.circleId) return false;
    chooseScope({ kind: "circles", circleIds: [choice.circleId] });
    return true;
  });
  return null;
}
