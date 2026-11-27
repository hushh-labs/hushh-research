"use client";

import { Capacitor } from "@capacitor/core";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { LocationChatActionCard, type LocationChatActionModel } from "@/components/agent/location-chat-action/location-chat-action-card";
import { LocationChatSharePicker, type PrivateLocationSelection } from "@/components/agent/location-chat-action/location-chat-share-picker";
import { LocationChatPublicShare } from "@/components/agent/location-chat-action/location-chat-public-share";
import { LocationChatPublicLinks } from "@/components/agent/location-chat-action/location-chat-public-links";
import { captureChatLocation, chatLocationPermissionIssue, enableChatDeviceLocation, LocationChatPermissionRecovery, type ChatLocationPermissionIssue } from "@/components/agent/location-chat-action/location-chat-permission";
import { MapRendererAccess } from "@/components/one-location/map-renderer-access";
import { Button } from "@/components/ui/button";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { flushLocationStops, hasQueuedLocationStop, locationStopQueueRevision, queueLocationStop, subscribeLocationStopQueue } from "@/lib/location/pending-stops";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { coarsenPoint } from "@/lib/location/coarsen";
import { getLocationAccountSettings, LocationAccountSettingsResource, updateLocationAccountSettings } from "@/lib/location/account-settings";
import { decryptLocationEnvelope, encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { liveFreshness } from "@/lib/one-location/freshness";
import { isFixedLocationGrant } from "@/lib/one-location/notifications";
import { locationBlockReason } from "@/lib/one-location/location-readiness";
import { readOneLocationControlState, updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { GOOGLE_MAPS_RENDERER_CONSENT_VERSION } from "@/lib/one-location/map-renderer-consent";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationEncryptedEnvelope, OneLocationState, PlainLocationPoint } from "@/lib/one-location/types";
import { publishOneLocationMapPreferences, useOneLocationMapPreferences } from "@/lib/one-location/use-one-location-map-preferences";
import {
  executeMainLocationPlan, expandMainLocationTarget, prepareMainLocationPlan, resolveMainLocationChoices,
  restoreMainLocationPlans, type MainLocationAction, type MainLocationChoice, type MainLocationPlan,
  type MainLocationContinuation, type MainLocationProposal, type MainLocationTarget,
} from "@/lib/agent/main-chat-location";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { settleMainLocationBatch } from "@/lib/agent/main-chat-location-batch";
import { exactDirectSharePlans, exactDirectShareTargets, literalShareProposal, locationChoiceFromReply, locationDurationReply, locationPlanSentence, locationReviewDecision, sameDirectShareRecipients, type DirectLocationShare, type LocationConversationReply } from "@/lib/agent/main-chat-location-conversation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";

const LiveMap = dynamic(() => import("@/components/one-location/live-map").then((module) => module.LiveMap));
const LocationSetupFlow = dynamic(() => import("@/components/location/setup/location-setup-flow").then((module) => module.LocationSetupFlow), {
  loading: () => <p role="status">Opening Location setup…</p>,
});
const LocationChatSafety = dynamic(() => import("@/components/agent/location-chat-action/location-chat-safety").then((module) => module.LocationChatSafety), {
  loading: () => <p role="status">Opening Save My Soul…</p>,
});
const LocationChatWorkspace = dynamic(() => import("@/components/agent/location-chat-action/location-chat-workspace").then((module) => module.LocationChatWorkspace), {
  loading: () => <p role="status">Opening Location…</p>,
});
const LocationChatCheckIn = dynamic(() => import("@/components/agent/location-chat-action/location-chat-check-in").then((module) => module.LocationChatCheckIn), {
  loading: () => <p role="status">Opening check-in…</p>,
});

const titles: Record<MainLocationAction, string> = {
  share_options: "Share your location", share_private: "Share privately", share_public: "Public location link",
  share_live: "Share live location", share_pin: "Location sharing", ask: "Ask for location",
  view: "View location", list_shares: "Location shares", list_requests: "Location requests",
  stop: "Stop sharing", set_duration: "Change end time", extend: "Add time",
  ask_extension: "Request extra time", approve: "Approve request", decline: "Decline request",
  setup_location: "Set up Location", enable_location: "Turn on Location sharing", enable_device_location: "Enable device location",
  resume_updates: "Resume location updates", sos_review: "Save My Soul", sos_stop: "Stop Save My Soul", sms_contacts: "Emergency contacts",
  manage_circles: "Location Circles", manage_places: "Saved places", manage_ratings: "Place ratings", manage_contacts: "Find contacts", manage_settings: "Location settings", manage_links: "Public location links",
  enable_auto_approve: "Turn on automatic approval", disable_auto_approve: "Turn off automatic approval",
  check_in: "Private check-in", nearby_check_in: "Nearby check-in",
  view_self: "Your current location",
};
const initialDurations = [15, 60, 480];
const editDurations = [15, 30, 60, 120, 480];
const isReadList = (action: MainLocationAction) => action === "list_shares" || action === "list_requests";
const isPublish = (action: MainLocationAction) => action === "share_live" || action === "share_pin";
const needsTime = (action: MainLocationAction) =>
  action === "share_live" || action === "set_duration" || action === "extend" || action === "ask_extension";

function errorMessage(error: unknown) {
  if (chatLocationPermissionIssue(error) === "denied") return "Location permission was denied.";
  if (!navigator.onLine) return "You’re offline. Reconnect and try again.";
  if (error instanceof ApiError && error.status >= 500) return "Location is unavailable right now. Try again.";
  return error instanceof Error ? error.message : "Couldn’t complete this Location action. Try again.";
}

async function capturePoint(token: string): Promise<PlainLocationPoint> {
  const [{ point: position, reducedAccuracy }, settings] = await Promise.all([
    captureChatLocation(),
    getLocationAccountSettings(token),
  ]);
  if (!Number.isFinite(position.latitude) || Math.abs(position.latitude) > 90 ||
      !Number.isFinite(position.longitude) || Math.abs(position.longitude) > 180) {
    throw new Error("Couldn’t get a current position. Try again.");
  }
  return coarsenPoint(position, settings.precision === "approximate" || reducedAccuracy || (position.accuracyM ?? 0) >= 1000
    ? "approximate" : "precise");
}

function InlineLocationMap({ point, token, ownerId, label }: {
  point: PlainLocationPoint; token: string; ownerId: string; label: string;
}) {
  const { preferences, loading } = useOneLocationMapPreferences({ userId: ownerId, vaultOwnerToken: token });
  const [accessError, setAccessError] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const allowed = preferences?.rendererConsentVersion === GOOGLE_MAPS_RENDERER_CONSENT_VERSION;
  if (allowed) return <LiveMap point={point} displayName={label} className="h-52 overflow-hidden rounded-xl" />;
  return <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-sm">
    <p>{point.precision === "approximate" ? "Approximate position" : "Position"} · {point.latitude.toFixed(point.precision === "approximate" ? 2 : 5)}, {point.longitude.toFixed(point.precision === "approximate" ? 2 : 5)}</p>
    {!loading && !accepting ? <MapRendererAccess inline onAccept={() => { void (async () => {
      setAccepting(true);
      setAccessError(false);
      try {
        const next = await OneLocationService.updateMapPreferences({
          vaultOwnerToken: token, rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
        });
        publishOneLocationMapPreferences(ownerId, next);
      } catch { setAccessError(true); }
      finally { setAccepting(false); }
    })(); }} /> : null}
    {accessError ? <p role="status">Couldn’t open the map. Try again.</p> : null}
  </div>;
}

function snapshotFor(state: OneLocationState | null, plan: MainLocationPlan) {
  const requestId = plan.receipt?.requestId ?? plan.requestId;
  const request = state?.requests.find((row) => row.id === requestId);
  const id = request?.approvedGrantId ?? plan.receipt?.grantId ?? plan.grantId;
  const grant = id ? [...(state?.ownerGrants ?? []), ...(state?.receivedGrants ?? [])].find((row) => row.id === id) : undefined;
  return { request, grant, id };
}

type PanelProps = {
  proposal: MainLocationProposal;
  ownerId: string | null;
  token: string | null;
  vaultKey?: string | null;
  onUnlock: () => void;
  allowReview: boolean;
  onContinuationChange?: (proposalId: string, context: MainLocationContinuation | null) => void;
  claimEnable?: (proposalId: string) => boolean;
  claimDirectShare?: (proposal: MainLocationProposal) => DirectLocationShare | null;
  onConversationReply?: (proposalId: string, handler: LocationConversationReply | null) => void;
  onConversationText?: (proposalId: string, text: string) => void;
};

export function LocationChatActionPanel(props: PanelProps) {
  const { onConversationText, onConversationReply, proposal } = props;
  const publish = useCallback((text: string) => onConversationText?.(proposal.id, text), [onConversationText, proposal.id]);
  const register = useCallback((handler: LocationConversationReply | null) => onConversationReply?.(proposal.id, handler), [onConversationReply, proposal.id]);
  const childConversation = onConversationText && props.allowReview ? { onConversationText: publish, onConversationReply: register } : {};
  const node = useRef<HTMLDivElement>(null);
  const [activated, setActivated] = useState(props.allowReview);
  const [nearViewport, setNearViewport] = useState(props.allowReview);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") { setActivated(true); setNearViewport(true); return; }
    if (props.allowReview) setActivated(true);
    if (!node.current) return;
    const observer = new IntersectionObserver((entries) => {
      const near = entries.some((entry) => entry.isIntersecting);
      setNearViewport(near);
      if (near) setActivated(true);
    }, { rootMargin: "120px" });
    observer.observe(node.current);
    return () => observer.disconnect();
  }, [props.allowReview]);
  const action = props.proposal.action;
  const safety = action === "sos_review" || action === "sos_stop" || action === "sms_contacts";
  return <div ref={node}>{activated ? safety
    ? props.ownerId && props.token
      ? <LocationChatSafety key={props.ownerId} action={action} ownerId={props.ownerId} token={props.token} allowReview={props.allowReview} {...childConversation} />
      : props.allowReview ? <UnlockLocationCard onUnlock={props.onUnlock} /> : null
    : <LocationChatActionContent {...props} nearViewport={nearViewport} childConversation={childConversation} /> : null}</div>;
}

function UnlockLocationCard({ onUnlock }: { onUnlock: () => void }) {
  return <LocationChatActionCard model={{
    phase: "recovery", title: "Unlock Location in this chat",
    description: "Unlock your vault to review the Location action.",
    actions: [{ id: "unlock", label: "Unlock vault", variant: "primary" }],
  }} onRecover={onUnlock} />;
}

function LocationChatActionContent({ proposal, ownerId, token, vaultKey, onUnlock, allowReview, onContinuationChange, claimEnable, claimDirectShare, onConversationReply, onConversationText, nearViewport, childConversation }: PanelProps & {
  nearViewport: boolean;
  childConversation: { onConversationText?: (text: string) => void; onConversationReply?: (handle: LocationConversationReply | null) => void };
}) {
  const conversational = Boolean(onConversationText);
  const now = useCoarseClock(15_000);
  useSyncExternalStore(subscribeLocationStopQueue, locationStopQueueRevision, () => 0);
  const [intent, setIntent] = useState(proposal);
  const [state, setState] = useState<OneLocationState | null>(null);
  const [choices, setChoices] = useState<MainLocationChoice[] | null>(null);
  const [selected, setSelected] = useState<MainLocationTarget[]>([]);
  const [pickerDraft, setPickerDraft] = useState<PrivateLocationSelection | null>(null);
  const [plans, setPlans] = useState<MainLocationPlan[] | null>(null);
  const [settled, setSettled] = useState<MainLocationPlan[]>([]);
  const [retryRevision, setRetryRevision] = useState(0);
  const [stage, setStage] = useState<"loading" | "choose" | "terms" | "review" | "settled" | "cancelled" | "error" | "sharing-off" | "setup-offer" | "setup" | "device-paused" | "device-permission" | "share-menu" | "private-picker" | "public-share" | "workspace" | "links" | "check-in" | "self-location">("loading");
  const [error, setError] = useState<string>();
  const [permissionIssue, setPermissionIssue] = useState<ChatLocationPermissionIssue>(null);
  const [standaloneStatus, setStandaloneStatus] = useState<string>();
  const [publicDraftHours, setPublicDraftHours] = useState<number>();
  const [staleReview, setStaleReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PlainLocationPoint | null>(null);
  const [points, setPoints] = useState<Record<string, PlainLocationPoint>>({});
  const [failedLabels, setFailedLabels] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const encryptedAttempts = useRef(new Map<string, OneLocationEncryptedEnvelope>());
  const busyRef = useRef(false);
  const revision = useRef(0);
  const alive = useRef(false);
  const dismiss = () => {
    revision.current += 1;
    setBusy(false);
    setStage(settled.length ? "settled" : "cancelled");
    setPreview(null);
  };
  const backToSharing = () => {
    setError(undefined);
    if (intent.action === "ask") { dismiss(); return; }
    setStage(proposal.action === "manage_links" ? "links" : proposal.action === "share_public" ? "cancelled" : "share-menu");
  };
  useBackLayer(ROUTES.HOME, allowReview && token && [
    "choose", "terms", "review", "setup-offer", "setup", "sharing-off", "device-paused", "device-permission",
    "share-menu", "private-picker", "public-share", "workspace", "links", "check-in", "self-location",
  ].includes(stage) ? 1 : 0, () => {
    if (busyRef.current) return true;
    if (stage === "private-picker" || stage === "public-share") backToSharing();
    else dismiss();
    return true;
  });
  const loadState = useCallback(async () => {
    if (!ownerId || !token) throw new Error("Unlock your vault to continue.");
    return OneLocationStateResource.load(ownerId, () => OneLocationService.getState(token));
  }, [ownerId, token]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revision.current += 1; };
  }, []);

  useEffect(() => {
    const network = () => setOnline(navigator.onLine);
    network();
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, []);

  const refresh = useCallback(() => {
    if (!token || !ownerId || !navigator.onLine) return;
    const request = revision.current;
    void loadState().then((next) => {
      if (alive.current && request === revision.current) setState(next);
    }).catch(() => undefined);
  }, [loadState, ownerId, token]);

  const tracksCurrentActivity = isReadList(intent.action) || settled.some((plan) => {
    const { grant, request, id } = snapshotFor(state, plan);
    return Boolean(request?.status === "pending" || (grant?.status === "active" &&
      (!grant.expiresAt || Date.parse(grant.expiresAt) > now)) || (!state && id));
  });

  useEffect(() => {
    if (!ownerId || !token || (stage !== "settled" && stage !== "choose")) return;
    const unsubscribe = subscribeToOneLocationStateChanges((event) => {
      if (event.userId === ownerId) refresh();
    });
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => { unsubscribe(); window.removeEventListener("online", refresh); window.removeEventListener("focus", refresh); };
  }, [ownerId, refresh, stage, token]);

  useEffect(() => {
    if (!nearViewport || !ownerId || !token || !tracksCurrentActivity) return;
    const refreshVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = window.setInterval(refreshVisible, 10_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [nearViewport, ownerId, refresh, token, tracksCurrentActivity]);

  useEffect(() => {
    if (!token || !ownerId) return;
    const version = ++revision.current;
    setStage("loading");
    setSettled([]);
    setPlans(null);
    setState(null);
    setError(undefined);
    setStandaloneStatus(undefined);
    void (async () => {
      try {
        if (proposal.action === "view_self") { setStage(allowReview ? "self-location" : "cancelled"); return; }
        if (["manage_circles", "manage_places", "manage_ratings", "manage_contacts", "manage_settings", "enable_auto_approve", "disable_auto_approve"].includes(proposal.action)) {
          setStage(allowReview ? "workspace" : "cancelled");
          return;
        }
        if (proposal.action === "manage_links") { setStage(allowReview ? "links" : "cancelled"); return; }
        if (proposal.action === "check_in" || proposal.action === "nearby_check_in") {
          if (!allowReview) { setStage("cancelled"); return; }
          if (proposal.action === "nearby_check_in") { setStage("check-in"); return; }
          const settings = await getLocationAccountSettings(token);
          if (!stillCurrent(version)) return;
          setStage(settings.sharing_state === "unset" ? "setup-offer" :
            settings.sharing_state === "off" ? "sharing-off" : "check-in");
          return;
        }
        if (proposal.action === "setup_location" || proposal.action === "enable_location" ||
            proposal.action === "enable_device_location" || proposal.action === "resume_updates") {
          if (!allowReview) { setStage("cancelled"); return; }
          if (proposal.action === "setup_location") { setStage("setup-offer"); return; }
          if (proposal.action === "resume_updates" && conversational) { await reviewResumeState(version); return; }
          if (proposal.action === "enable_device_location" && conversational) {
            setStage("device-permission");
            return;
          }
          const settings = await getLocationAccountSettings(token);
          if (!alive.current || version !== revision.current) return;
          if (proposal.action === "enable_device_location" && settings.sharing_consent_accepted_at) {
            setStage("device-permission");
          } else if (settings.sharing_state !== "on") {
            setStage(settings.sharing_state === "off" ? "sharing-off" : "setup-offer");
          } else if (conversational && proposal.action === "enable_location") {
            setStage("device-permission");
          } else if (readOneLocationControlState(ownerId).paused) {
            setStage("device-paused");
          } else {
            setStandaloneStatus(proposal.action === "resume_updates" ? "Location updates are already resumed." : "Location sharing is on.");
            setStage("settled");
          }
          return;
        }
        const previous = await restoreMainLocationPlans(token, proposal.id);
        if (!alive.current || version !== revision.current) return;
        const completed = previous.filter((plan) => plan.status === "executed");
        const pending = allowReview ? previous.filter((plan) => plan.action !== "share_pin" && plan.status === "pending" &&
          (!plan.expiresAt || Date.parse(plan.expiresAt) > Date.now())) : [];
        const next = pending[0];
        if (next) {
          const resumable = pending.filter((plan) => plan.attemptId === next.attemptId && plan.action === next.action);
          setIntent({ ...proposal, action: next.action, durationHours: next.durationHours ?? undefined,
            durationMode: next.durationMode ?? undefined, attemptId: next.attemptId ?? undefined });
          setSelected(resumable.map((plan) => ({
            label: plan.personDisplayLabel || "Recipient", personUserId: plan.personUserId ?? undefined,
            grantId: plan.grantId ?? undefined, requestId: plan.requestId ?? undefined, circleId: plan.circleId ?? undefined,
          })));
          setPlans(resumable);
          setSettled(completed);
          setStage("review");
          refresh();
          return;
        }
        if (completed.length) {
          setSettled(completed);
          setStage("settled");
          refresh();
          return;
        }
        if (!allowReview) { setStage("cancelled"); return; }
        if (proposal.action === "share_pin") {
          setStandaloneStatus("Location sharing is live. To start a live share, tell me who to share with and for how long.");
          setStage("settled");
          return;
        }
        if (proposal.action === "share_options" && !conversational) { setStage("share-menu"); return; }
        if (proposal.action === "share_public") { setStage("public-share"); return; }
        if ((proposal.action === "share_private" && !conversational) ||
            ((proposal.action === "share_options" || proposal.action === "share_private" || isPublish(proposal.action) || proposal.action === "ask") && !proposal.people?.length && !proposal.circles?.length)) {
          setStage("private-picker");
          return;
        }
        const draft = conversational && (proposal.action === "share_private" || proposal.action === "share_options")
          ? { ...proposal, action: "share_live" as const } : proposal;
        const direct = !previous.length && conversational && draft.action === "share_live" && claimDirectShare?.(proposal);
        const available = await resolveMainLocationChoices({ token, ownerId, proposal: direct ? literalShareProposal(draft, direct) : draft, loadState });
        if (!alive.current || version !== revision.current) return;
        setChoices(available);
        setSelected([]);
        setIntent(draft);
        if (direct && direct.current()) {
          const exact = exactDirectShareTargets(direct, available);
          if (exact) {
            setSelected(exact);
            await withPending(requestVersion => prepare(draft, exact, requestVersion, false, direct));
            return;
          }
        }
        setStage(isReadList(proposal.action) ? "settled" : "choose");
        if (isReadList(proposal.action)) refresh();
      } catch (caught) {
        if (!alive.current || version !== revision.current) return;
        setStage("error");
        setError(errorMessage(caught));
      }
    })();
    return () => { revision.current += 1; };
  // refresh only restates canonical records; allowReview is checked when a fresh card opens.
  // Preparation consumes only a fresh, single-use composer authorization.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowReview, claimDirectShare, conversational, loadState, ownerId, proposal, refresh, retryRevision, token]);

  async function withPending(run: (version: number) => Promise<void>) {
    if (busyRef.current || !token || !ownerId) return;
    if (!online) { setError("You’re offline. Reconnect and try again."); return; }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setPermissionIssue(null);
    const version = revision.current;
    try { await run(version); }
    catch (caught) {
      if (alive.current && version === revision.current) {
        setError(errorMessage(caught));
        setPermissionIssue(chatLocationPermissionIssue(caught));
      }
    } finally {
      busyRef.current = false;
      if (alive.current && version === revision.current) setBusy(false);
    }
  }

  const stillCurrent = (version: number) => alive.current && version === revision.current;
  function announce() {
    if (ownerId) CacheSyncService.onOneLocationStateMutated(ownerId, ["workspace"]);
    dispatchFeedStateChanged("arrived");
    refresh();
  }

  async function continueAfterRecovery(version: number) {
    if (!stillCurrent(version) || !ownerId) return;
    switch (intent.action) {
      case "setup_location":
        setStandaloneStatus("Location setup is complete.");
        setStage("settled");
        return;
      case "enable_location":
      case "resume_updates":
        if (intent.action === "resume_updates" && conversational) { await reviewResumeState(version); return; }
        if (intent.action === "enable_location" && conversational) { await finishDeviceEnable(version); return; }
        if (readOneLocationControlState(ownerId).paused) { setStage("device-paused"); return; }
        setStandaloneStatus(intent.action === "resume_updates" ? "Location updates are resumed." : "Location sharing is on.");
        setStage("settled");
        return;
      case "enable_device_location":
        setStage("device-permission");
        return;
      case "check_in":
        setStage("check-in");
        return;
      default:
        await prepare(intent, selected, version, true);
    }
  }

  async function finishDeviceEnable(version: number) {
    if (!ownerId || !stillCurrent(version)) return;
    await enableChatDeviceLocation(() => stillCurrent(version));
    if (!stillCurrent(version)) return;
    if (intent.action === "resume_updates") { await reviewResumeState(version, true); return; }
    if (intent.action === "enable_location" && readOneLocationControlState(ownerId).paused) {
      setStage("device-paused");
      return;
    }
    setStandaloneStatus(intent.action === "enable_location" ? "Location is on for this device and your account." : "Device location permission is on.");
    setStage("settled");
  }

  async function reviewResumeState(version: number, deviceGranted = false) {
    if (!ownerId || !token || !stillCurrent(version)) return;
    const [settings, permission] = await Promise.all([
      getLocationAccountSettings(token), deviceGranted ? null : OneLocationService.getPermissionState().catch(() => null),
    ]);
    if (!stillCurrent(version)) return;
    if (settings.sharing_state !== "on") { setStage(settings.sharing_state === "off" ? "sharing-off" : "setup-offer"); return; }
    if (readOneLocationControlState(ownerId).paused) { setStage("device-paused"); return; }
    if (!deviceGranted && (permission?.state !== "granted" || locationBlockReason(permission))) { setStage("device-permission"); return; }
    setStandaloneStatus("Location updates are on for this device.");
    setStage("settled");
  }

  async function recoverConversation(version: number) {
    if (!ownerId || !token) return;
    if (stage === "device-permission") { await finishDeviceEnable(version); return; }
    if (stage === "setup-offer") { setStage("setup"); return; }
    if (stage === "device-paused") {
      await enableChatDeviceLocation(() => stillCurrent(version));
      if (!stillCurrent(version)) return;
      const settings = await getLocationAccountSettings(token);
      if (!stillCurrent(version)) return;
      if (settings.sharing_state !== "on") { setStage(settings.sharing_state === "off" ? "sharing-off" : "setup-offer"); return; }
      updateOneLocationControlState(ownerId, current => ({ ...current, paused: false }));
      if (intent.action === "resume_updates") { await reviewResumeState(version, true); return; }
      if (intent.action === "enable_location") {
        setStandaloneStatus("Location is on for this device and your account."); setStage("settled"); return;
      }
    } else {
      try {
        const outcome = await updateLocationAccountSettings(token, { sharingState: "on" });
        if (!stillCurrent(version)) return;
        LocationAccountSettingsResource.write(ownerId, outcome.settings);
        if (outcome.settings.sharing_state !== "on") throw new Error("Location sharing is still off.");
      } catch (caught) {
        if (!stillCurrent(version)) return;
        if (apiErrorCode(caught) !== "LOCATION_SHARING_CONSENT_REQUIRED") throw caught;
        setStage("setup"); return;
      }
    }
    await continueAfterRecovery(version);
  }

  async function prepare(next: MainLocationProposal, targets: MainLocationTarget[], version: number, setupReady = false, direct?: DirectLocationShare) {
    if (!token || !ownerId) return;
    if (next.action === "share_pin") throw new Error("Location sharing is live. Ask to start a live share.");
    const startsSharing = isPublish(next.action) || next.action === "share_public" || (next.action === "approve" &&
      targets.some((item) => !item.request?.isExtension && !item.request?.extendsGrantId));
    if (startsSharing && !setupReady) {
      const settings = await getLocationAccountSettings(token);
      if (!stillCurrent(version)) return;
      if (settings.sharing_state !== "on") {
        setIntent(next);
        setSelected(targets);
        setStage(settings.sharing_state === "off" ? "sharing-off" : "setup-offer");
        return;
      }
    }
    if (next.action === "share_public") {
      setStage("public-share");
      return;
    }
    if (startsSharing && readOneLocationControlState(ownerId).paused) {
      setIntent(next);
      setSelected(targets);
      setStage("device-paused");
      return;
    }
    const expansion = await settleMainLocationBatch(targets, async (item) => {
      if (!stillCurrent(version)) throw new Error("The chat changed before this audience could be reviewed.");
      return expandMainLocationTarget(token, ownerId, item);
    });
    const expansionFailure = expansion.find((result) => result.status === "rejected");
    if (expansionFailure?.status === "rejected") throw expansionFailure.reason;
    const expanded = expansion.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const distinct = [...new Map(expanded.map((item) => [
      item.grantId || item.requestId || item.personUserId, item,
    ])).values()];
    if (!distinct.length) throw new Error("There’s nobody eligible in this audience.");
    let workingTargets = distinct;
    if (next.action === "ask") {
      const snapshot = await loadState();
      if (!stillCurrent(version)) return;
      const incoming = distinct.flatMap((target) => snapshot.receivedGrants.flatMap((grant) =>
        grant.ownerUserId === target.personUserId && grant.status === "active" && !isFixedLocationGrant(grant) &&
        (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now())
          ? [{ ...target, grantId: grant.id, grant,
            detail: grant.expiresAt
              ? `Live until ${new Date(grant.expiresAt).toLocaleString()}` : "Live until stopped" }]
          : []));
      const existing = new Set(incoming.map((target) => target.personUserId));
      workingTargets = distinct.filter((target) => !existing.has(target.personUserId));
      if (incoming.length) {
        const view = { ...next, action: "view" as const, durationHours: undefined, durationMode: undefined };
        if (!workingTargets.length && incoming.length > 1) {
          setIntent(view);
          setSelected([]);
          setChoices([{ label: "Already sharing with you", targets: incoming, requiresSelection: true }]);
          setStage("choose");
          return;
        }
        const opened = await settleMainLocationBatch(incoming, async (target) => {
          if (!stillCurrent(version)) throw new Error("The chat changed before this share could be opened.");
          const plan = await prepareMainLocationPlan(token, view, target);
          if (!stillCurrent(version)) throw new Error("The chat changed before this share could be opened.");
          return executeMainLocationPlan(token, plan.planId);
        });
        if (!stillCurrent(version)) return;
        const records = opened.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
        setSettled((prior) => [...prior.filter((record) => !records.some((row) => row.planId === record.planId)), ...records]);
        const failed = opened.find((item) => item.status === "rejected");
        if (!workingTargets.length) {
          if (!records.length) throw failed?.reason ?? new Error("The existing share could not be opened.");
          setStage("settled");
          refresh();
          return;
        }
      }
      if (!next.durationHours && next.durationMode !== "until_stopped") {
        setSelected(workingTargets);
        setStage("terms");
        return;
      }
    }
    if (!stillCurrent(version)) return;
    const outcomes = await settleMainLocationBatch(workingTargets, async (item) => {
      if (!stillCurrent(version)) throw new Error("The chat changed before this audience could be reviewed.");
      return prepareMainLocationPlan(token, next, item);
    });
    if (!stillCurrent(version)) return;
    const prepared = outcomes.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!prepared.length) {
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      throw failure?.reason ?? new Error("No Location actions could be prepared.");
    }
    setFailedLabels(outcomes.flatMap((result, index) => result.status === "rejected" ? [workingTargets[index]?.label ?? "Recipient"] : []));
    setIntent(next);
    if (next.action === "view") {
      const results = await settleMainLocationBatch(prepared, async (plan) => {
        if (!stillCurrent(version)) throw new Error("The chat changed before this share could be opened.");
        return executeMainLocationPlan(token, plan.planId);
      });
      if (!stillCurrent(version)) return;
      const opened = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (!opened.length) {
        const failure = results.find((result) => result.status === "rejected");
        throw failure?.reason ?? new Error("The shares could not be opened.");
      }
      setSettled((prior) => [...prior, ...opened]);
      setStage("settled");
      refresh();
      return;
    }
    setSelected(targets);
    setPlans(prepared);
    setStaleReview(false);
    setPreview(null);
    setStage("review");
    if (direct?.current() && exactDirectSharePlans(direct, expanded, prepared) && prepared.length === outcomes.length) {
      await commit(version, prepared, { share: direct, targets, expanded });
    }
  }

  async function start(next: MainLocationProposal, targets: MainLocationTarget[], version: number) {
    setIntent(next);
    setSelected(targets);
    setFailedLabels([]);
    if (next.action !== "ask" && needsTime(next.action) && !next.durationHours && next.durationMode !== "until_stopped") {
      setStage("terms");
    } else {
      await prepare(next, targets, version);
    }
  }

  const chooseIndex = selected.length;
  const currentChoice = choices?.[chooseIndex];
  const chosenOrSingle = currentChoice?.targets.length === 1 && !currentChoice.requiresSelection
      ? currentChoice.targets[0] : null;

  function selectChoice(target: MainLocationTarget) {
    if (!choices) return;
    const next = [...selected, target];
    if (next.length < choices.length) setSelected(next);
    else void withPending((version) => start(intent, next, version));
  }

  useEffect(() => {
    if (!allowReview || stage !== "choose" || !chosenOrSingle || !choices?.length) return;
    const next = [...selected, chosenOrSingle];
    if (next.length < choices.length) { setSelected(next); return; }
    void withPending((version) => start(intent, next, version));
    // Only auto-advance exact server-resolved single matches, once per choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, chosenOrSingle, choices, chooseIndex, allowReview]);

  async function commit(version: number, reviewed = plans, direct?: {
    share: DirectLocationShare; targets: MainLocationTarget[]; expanded: MainLocationTarget[];
  }) {
    if (!reviewed || !token || !ownerId) return;
    const current = () => stillCurrent(version) && (!direct || direct.share.current());
    const pending = reviewed.filter((plan) => plan.status === "pending");
    if (!pending.length) { setStage("settled"); return; }
    if (pending.some(plan => plan.action === "share_pin")) throw new Error("Location sharing is live. Ask to start a live share.");
    if (!current()) return;
    const envelopesByPlan = direct ? new Map<string, OneLocationEncryptedEnvelope>() : encryptedAttempts.current;
    let point = preview;
    if (pending.some((plan) => isPublish(plan.action) && !envelopesByPlan.has(plan.planId))) {
      if (!point) point = await capturePoint(token);
      if (!Number.isFinite(Date.parse(point.capturedAt)) || Math.abs(Date.now() - Date.parse(point.capturedAt)) > 55_000) {
        setPreview(null);
        throw new Error("The position changed or became stale. Capture a fresh preview before trying again.");
      }
    }
    if (!current()) return;
    async function envelopeFor(plan: MainLocationPlan) {
      let envelope = envelopesByPlan.get(plan.planId);
      if (!envelope && isPublish(plan.action)) {
        if (!point || !plan.recipientKey) throw new Error("The recipient’s secure location key is unavailable.");
        const precision = point.precision ?? "precise";
        const encrypted = await encryptLocationForRecipient({
          point, recipientKeyId: plan.recipientKey.keyId, recipientPublicKeyJwk: plan.recipientKey.publicKeyJwk,
        });
        envelope = { ...encrypted, metadata: { precision }, publicationContext: "foreground_map_visible" };
        envelopesByPlan.set(plan.planId, envelope);
      }
      return envelope;
    }
    if (direct) {
      // Prepare all encryption locally before the first grant can be created.
      const envelopes = await settleMainLocationBatch(pending, envelopeFor);
      const failure = envelopes.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (!current()) return;
      const [latestDirectory, membership, settings] = await Promise.all([
        resolveMainLocationChoices({ token, ownerId, loadState, proposal: literalShareProposal(proposal, direct.share) }),
        settleMainLocationBatch(direct.targets, target => expandMainLocationTarget(token, ownerId, target)),
        getLocationAccountSettings(token),
      ]);
      const fresh = membership.flatMap(result => result.status === "fulfilled" ? result.value : []);
      if (!current()) return;
      const latestTargets = exactDirectShareTargets(direct.share, latestDirectory);
      if (settings.sharing_state !== "on" || readOneLocationControlState(ownerId).paused ||
          !point || settings.precision === "approximate" && point.precision !== "approximate" ||
          Math.abs(Date.now() - Date.parse(point.capturedAt)) > 55_000 ||
          !latestTargets || !sameDirectShareRecipients(direct.targets, latestTargets) ||
          membership.some(result => result.status === "rejected") || !sameDirectShareRecipients(direct.expanded, fresh) ||
          !exactDirectSharePlans(direct.share, fresh, pending)) {
        setStaleReview(true);
        setError("The audience or sharing terms changed. Please send the request again for a fresh review.");
        return;
      }
    }
    const results = await settleMainLocationBatch(pending, async (plan) => {
      if (!current()) throw new Error("The chat changed before this action could be sent.");
      const envelope = await envelopeFor(plan);
      if (!current()) throw new Error("The chat changed before this action could be sent.");
      if (direct && envelope) encryptedAttempts.current.set(plan.planId, envelope);
      const outcome = await executeMainLocationPlan(token, plan.planId, envelope);
      if (outcome.status !== "executed" || outcome.planId !== plan.planId) throw new Error("The Location action has no confirmed receipt yet.");
      return outcome;
    });
    const delivered = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (delivered.length) announce();
    if (!stillCurrent(version)) return;
    const nextSettled = [...new Map([...settled, ...delivered].map((plan) => [plan.planId, plan])).values()];
    setSettled(nextSettled);
    setPlans(pending.filter((_, index) => results[index]?.status === "rejected"));
    if (delivered.length === results.length) setStage("settled");
    else {
      const failure = results.find((outcome) => outcome.status === "rejected");
      setStaleReview(failure?.reason instanceof ApiError && [409, 410].includes(failure.reason.status));
      setError(errorMessage(failure?.reason));
    }
  }

  const viewIds = settled.filter((plan) => plan.action === "view" && (!conversational || allowReview)).flatMap((plan) => {
    const { grant, id } = snapshotFor(state, plan);
    return id && (!grant || (grant.status === "active" && (!grant.expiresAt || Date.parse(grant.expiresAt) > now))) ? [id] : [];
  }).join(",");
  useEffect(() => {
    if (!token || !ownerId || !viewIds) { setPoints({}); return; }
    if (!nearViewport) return;
    const ids = viewIds.split(",");
    let cancelled = false;
    let running = false;
    async function read() {
      if (cancelled || running || !navigator.onLine || document.visibilityState === "hidden") return;
      running = true;
      try {
        const next = await settleMainLocationBatch(ids, async (id) => {
          if (cancelled) throw new Error("The Location view was closed.");
          const response = await OneLocationService.viewEnvelope({ vaultOwnerToken: token!, grantId: id });
          return [id, response.envelope ? await decryptLocationEnvelope({ userId: ownerId!, envelope: response.envelope }) : null] as const;
        });
        if (!cancelled) setPoints((previous) => Object.fromEntries(next.flatMap((result, index) => {
          if (result.status === "fulfilled") return result.value[1] ? [[result.value[0], result.value[1]]] : [];
          if (result.reason instanceof ApiError && [401, 403, 404, 410].includes(result.reason.status)) return [];
          const id = ids[index];
          return id && previous[id] ? [[id, previous[id]]] : [];
        })));
      } finally { running = false; }
    }
    void read();
    const timer = window.setInterval(() => { void read(); }, 5_000);
    window.addEventListener("online", read);
    window.addEventListener("focus", read);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("online", read); window.removeEventListener("focus", read); };
  }, [nearViewport, ownerId, token, viewIds]);

  useEffect(() => {
    if (!allowReview || !ownerId || !token || !onContinuationChange) return;
    const step = stage === "share-menu" ? "visibility"
      : stage === "private-picker" || stage === "choose" ? "audience"
        : stage === "terms" ? "duration"
          : stage === "public-share" || stage === "review" ? "review"
            : stage === "settled" && settled.length ? "receipt" : null;
    if (!step) return;
    const usePicker = stage === "private-picker";
    const action = usePicker ? pickerDraft?.mode ?? (conversational
      ? (intent.action === "ask" ? "ask" : "share_live") : "share_private")
      : stage === "public-share" ? "share_public" : intent.action;
    const audience = usePicker ? pickerDraft?.targets ?? [] : selected;
    const people = audience.filter((target) => target.personUserId).map((target) => target.label);
    const circles = audience.filter((target) => target.circleId && !target.personUserId).map((target) => target.label);
    const lastPerson = settled.length === 1 ? settled[0]?.personDisplayLabel : undefined;
    onContinuationChange(proposal.id, {
      step, action,
      people: (people.length ? people : intent.people ?? (step === "receipt" && lastPerson ? [lastPerson] : [])).slice(0, 20),
      circles: (circles.length ? circles : intent.circles ?? []).slice(0, 5),
      durationHours: action === "share_pin" ? undefined : intent.durationHours,
      ...(action === "share_live" || action === "set_duration" ? { durationMode: intent.durationMode } : {}),
    });
    return () => onContinuationChange(proposal.id, null);
  }, [allowReview, conversational, intent, onContinuationChange, ownerId, pickerDraft, proposal.id, selected, settled, stage, token]);

  function follow(action: MainLocationAction, target: MainLocationTarget) {
    const next = { id: proposal.id, attemptId: crypto.randomUUID(), action };
    void withPending((version) => start(next, [target], version));
  }

  const inRecovery = ["device-permission", "setup-offer", "sharing-off", "device-paused"].includes(stage);
  const reviewedText = plans?.length ? locationPlanSentence(plans, selected, false) : "";
  const choiceText = currentChoice?.targets.map((item, index) =>
    `${index + 1}. ${item.label}${item.detail ? ` (${item.detail})` : ""}`).join("\n");
  const subject = selected.map(target => target.label).join(", ");
  const receiptText = settled.map(plan => locationPlanSentence([plan], selected, true)).filter(Boolean).join(" ");
  let question = "";
  if (conversational) {
    if (stage === "private-picker" || stage === "share-menu") question = intent.action === "ask"
      ? "Whose location would you like to request?" : "Which person or circle would you like to share your location with?";
    if (stage === "choose" && !chosenOrSingle && currentChoice) question = choiceText
      ? `Which ${currentChoice.label} did you mean? Reply with the number.\n${choiceText}`
      : currentChoice.unavailableReason ?? `I couldn’t find an eligible match for ${currentChoice.label}. What name should I look for?`;
    if (stage === "terms") question = intent.action === "ask" ? `How long would you like ${subject} to share their location?`
      : intent.action === "extend" || intent.action === "ask_extension" ? `How much extra time would you like for the location share with ${subject}?`
      : `How long would you like to share your location with ${subject}?`;
    if (stage === "review") question = failedLabels.length ? `I couldn’t prepare ${failedLabels.join(", ")}. Please send the intended audience again.`
      : staleReview ? "The Location details changed. Please send the request again for a fresh review."
      : reviewedText || "I couldn’t verify the recipients. Please send the request again.";
    if (stage === "settled") question = standaloneStatus || receiptText;
    if (stage === "settled" && isReadList(intent.action)) {
      const listed = choices?.[0]?.targets ?? [];
      question = listed.length ? [titles[intent.action], ...listed.map(item => `${item.label}${item.detail ? ` · ${item.detail}` : ""}`)].join("\n")
        : intent.action === "list_shares" ? "There are no active location shares." : "There are no location requests.";
    }
    if (stage === "cancelled" && allowReview) question = "Cancelled.";
    if (stage === "device-permission") question = "Allow this device to use Location? Reply yes to check its permission.";
    if (stage === "device-paused") question = "Location updates are paused. Resuming can restart active shares on this device. Reply yes to resume.";
    if (stage === "setup-offer") question = "Location needs your sharing consent first. Reply yes to open setup.";
    if (stage === "sharing-off") question = "Location sharing is off in your account. Reply yes to turn it on.";
    if (error) question = `${receiptText ? `${receiptText} ` : ""}${error}${allowReview && (inRecovery || stage === "review" && !staleReview) ? " Reply yes to try again." : ""}`;
  }
  useEffect(() => {
    if (question && !busy && ownerId && token) onConversationText?.(proposal.id, question);
  }, [busy, onConversationText, ownerId, proposal.id, question, token]);

  useLayoutEffect(() => {
    if (!conversational || stage === "setup" || stage === "workspace" || stage === "links" || stage === "public-share" ||
        !allowReview || !ownerId || !token || !onConversationReply) return;
    const handle: LocationConversationReply = (text, displayedQuestion) => {
      if (!alive.current || busyRef.current) return false;
      if (displayedQuestion !== undefined && displayedQuestion !== question) return false;
      const decision = locationReviewDecision(text);
      if (decision === "cancel" && stage !== "settled" && stage !== "cancelled" && stage !== "loading") { dismiss(); return true; }
      if (stage === "choose" && currentChoice && !chosenOrSingle) {
        const target = locationChoiceFromReply(text, currentChoice.targets);
        if (target) { selectChoice(target); return true; }
      }
      if (stage === "terms" && selected.length) {
        const hours = locationDurationReply(text);
        if (hours) { void withPending(version => prepare({ ...intent, durationHours: hours, durationMode: "timed" }, selected, version)); return true; }
      }
      if (decision !== "confirm") return false;
      if (inRecovery) { void withPending(recoverConversation); return true; }
      if (stage !== "review" || !reviewedText || !plans?.length || staleReview || failedLabels.length) return false;
      void withPending(version => commit(version));
      return true;
    };
    onConversationReply(proposal.id, handle);
    return () => onConversationReply(proposal.id, null);
  });

  useEffect(() => {
    if (!conversational || !allowReview || !ownerId || !token || !inRecovery || stage === "device-paused" ||
        (proposal.action !== "enable_location" && proposal.action !== "enable_device_location")) return;
    if (claimEnable?.(proposal.id)) void withPending(recoverConversation);
    // The live composer grants one attempt. Re-mounting or refreshing cannot mint another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowReview, claimEnable, conversational, inRecovery, ownerId, proposal.action, proposal.id, stage, token]);

  if (!ownerId || !token) return allowReview ? <UnlockLocationCard onUnlock={onUnlock} /> : null;
  if (conversational && stage !== "setup" && stage !== "workspace" && stage !== "links" && stage !== "public-share") return <>
    <LocationChatPermissionRecovery issue={permissionIssue} />
    {allowReview && settled.filter(plan => plan.action === "view").map(plan => {
      const { id } = snapshotFor(state, plan);
      const point = id && points[id];
      return point ? <InlineLocationMap key={plan.planId} point={point} token={token} ownerId={ownerId}
        label={plan.personDisplayLabel || "Shared location"} /> : null;
    })}
  </>;
  if (!allowReview && stage === "cancelled" && !settled.length) return null;
  if (stage === "loading") return <LocationChatActionCard model={{ phase: "result", title: titles[intent.action], status: "Getting Location details…" }} busy />;
  if (stage === "error") return <LocationChatActionCard model={{
    phase: "recovery", title: titles[intent.action], error,
    actions: [{ id: "retry", label: "Try again", variant: "primary" }],
  }} onRecover={() => setRetryRevision((value) => value + 1)} />;
  if (stage === "workspace" && allowReview) return vaultKey ? <LocationChatWorkspace
    {...childConversation}
    mode={proposal.action === "manage_circles" ? "circles" : proposal.action === "manage_places" ? "saved_places"
      : proposal.action === "manage_ratings" ? "ratings" : proposal.action === "manage_contacts" ? "contacts" : "settings"}
    ownerId={ownerId} token={token} vaultKey={vaultKey} onBack={dismiss} onChanged={announce}
    autoApprovalIntent={proposal.action === "enable_auto_approve" ? "enable" : proposal.action === "disable_auto_approve" ? "disable" : undefined}
    suggestedAutoApprovalCircles={proposal.action === "enable_auto_approve" ? proposal.circles : undefined}
    suggestedCircleName={proposal.circles?.[0]} suggestedPersonName={proposal.people?.[0]} /> :
    <UnlockLocationCard onUnlock={onUnlock} />;
  if (stage === "links" && allowReview) return <LocationChatPublicLinks {...childConversation}
    ownerId={ownerId} token={token} loadState={loadState} onChanged={announce} onBack={dismiss}
    onCreate={() => { setIntent({ ...proposal, action: "share_public" }); setStage("public-share"); }} />;
  if (stage === "check-in" && allowReview) return <LocationChatCheckIn
    proposal={proposal} ownerId={ownerId} token={token} vaultKey={vaultKey} capturePoint={() => capturePoint(token)}
    onBack={dismiss} onChanged={announce}
    renderPoint={(point) => <InlineLocationMap point={point} ownerId={ownerId} token={token} label="You" />} />;
  if (stage === "self-location" && allowReview) return <>
    <LocationChatActionCard model={{
      phase: "result", title: "Your current location", mode: "current", updatedAt: preview?.capturedAt, error,
      actions: [{ id: "capture", label: preview ? "Refresh location" : "Show current location", variant: "primary" },
        { id: "cancel", label: "Close" }],
    }} busy={busy} onRecover={(action, event) => {
      if (action === "cancel") { dismiss(); return; }
      if (!event.nativeEvent.isTrusted) return;
      void withPending(async (version) => {
        const point = await capturePoint(token);
        if (stillCurrent(version)) setPreview(point);
      });
    }} map={preview ? <InlineLocationMap point={preview} ownerId={ownerId} token={token} label="You" /> : undefined} />
    <LocationChatPermissionRecovery issue={permissionIssue} />
  </>;

  function renderRecord(plan: MainLocationPlan, display?: MainLocationTarget) {
    const snapshot = snapshotFor(state, plan);
    const { id } = snapshot;
    const grant = snapshot.grant ?? (!state ? display?.grant : undefined);
    const request = snapshot.request ?? (!state ? display?.request : undefined);
    const label = plan.personDisplayLabel || (grant?.ownerUserId === ownerId ? grant?.recipientDisplayName : grant?.ownerDisplayName) || "Location";
    const incoming = grant?.recipientUserId === ownerId;
    const queued = Boolean(id && hasQueuedLocationStop(ownerId, id));
    const active = grant?.status === "active" && (!grant.expiresAt || Date.parse(grant.expiresAt) > now);
    const point = id && active && online && incoming ? points[id] : null;
    const liveStatus = plan.action === "view" && incoming
      ? !point ? "Waiting for a location update"
        : liveFreshness(point.capturedAt, now, 60_000).state === "paused" ? "Last known location" : "Live"
      : "Live";
    const actionButtons = request?.status === "pending" && request.ownerUserId === ownerId
      ? [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }]
      : active && incoming
        ? [{ id: "view", label: "View location" }, ...(grant.shareKind !== "pin" && grant.expiresAt ? [{ id: "ask_extension", label: "Ask for more time" }] : [])]
        : active
          ? [...(grant.shareKind !== "pin"
            ? [{ id: "set_duration", label: "Change end time" }, ...(grant.expiresAt ? [{ id: "extend", label: "Add time" }] : [])] : [])]
          : [];
    const requesting = plan.action === "ask" || plan.action === "ask_extension";
    const status = queued ? "Stopped on this device. Waiting to sync." : request
      ? request.status === "pending" && request.ownerUserId !== ownerId ? "Waiting for a response" : request.status
      : grant ? active ? grant.shareKind === "pin" ? "Current pin" : liveStatus : grant.status === "revoked" ? "Stopped" : "Ended"
        : plan.action === "stop" ? "Stopped" : requesting ? "Request sent"
          : state && id ? "Location no longer available"
          : plan.action === "view" ? "Waiting for a location update"
            : plan.action === "decline" ? "Declined" : plan.action === "approve" ? "Approved"
              : isPublish(plan.action) ? "Sent" : "Updated";
    const model: LocationChatActionModel = {
      phase: active && !queued && grant?.shareKind !== "pin" ? "active" : "result",
      mode: grant?.shareKind === "pin" || plan.action === "share_pin" ? "current" : grant ? "live" : undefined,
      title: display?.request ? "Location request" : titles[plan.action],
      subject: { label },
      status,
      endAt: grant?.expiresAt ?? plan.nextExpiresAt,
      untilStopped: grant?.durationMode === "until_stopped",
      updatedAt: point?.capturedAt,
      actions: queued ? [] : actionButtons,
      canStop: Boolean(active && !queued && !incoming && grant),
    };
    return <LocationChatActionCard key={plan.planId} model={model}
      onStop={(event) => {
        if (!event.nativeEvent.isTrusted || !grant || !ownerId || !token || queued) return;
        if (online) {
          follow("stop", { label, grant, grantId: grant.id, personUserId: grant.recipientUserId });
          return;
        }
        queueLocationStop(ownerId, grant.id);
        void flushLocationStops(ownerId, token).catch(() => undefined);
      }}
      onRecover={(action, event) => { if (event.nativeEvent.isTrusted) follow(action as MainLocationAction, {
        label, grant, request, grantId: grant?.id ?? undefined, requestId: request?.id ?? undefined,
        personUserId: incoming ? grant?.ownerUserId : grant?.recipientUserId,
      }); }}
      map={point ? <InlineLocationMap point={point} ownerId={ownerId!} token={token!} label={label} /> : undefined}
    />;
  }

  const results = settled.map((plan) => renderRecord(plan));
  if (stage === "share-menu") return <LocationChatActionCard model={{
    phase: "recovery", title: "Share your location", description: "Who should be able to open your location?",
    actions: [{ id: "private", label: "Share privately", variant: "primary" }, { id: "public", label: "Create a public link" }],
  }} onRecover={(action) => setStage(action === "private" ? "private-picker" : "public-share")} />;
  if (stage === "private-picker") return <LocationChatSharePicker token={token} ownerId={ownerId} busy={busy} error={error}
    suggestedPeople={proposal.people} suggestedCircles={proposal.circles}
    onSelectionChange={setPickerDraft}
    initialMode={proposal.action === "ask" ? "ask" : "share_live"} onBack={backToSharing}
    onContinue={(action, targets) => {
      void withPending((version) => start({
        ...proposal, action, people: undefined, circles: undefined,
      }, targets, version));
    }} />;
  if (stage === "public-share") return <LocationChatPublicShare {...childConversation} token={token} ownerId={ownerId} initialHours={publicDraftHours ?? proposal.durationHours}
    onDurationChange={(minutes) => setPublicDraftHours(minutes / 60)}
    loadState={loadState} capture={async () => {
      const settings = await getLocationAccountSettings(token);
      if (settings.sharing_state === "on") return capturePoint(token);
      setIntent({ ...proposal, action: "share_public" });
      setSelected([]);
      setStage(settings.sharing_state === "off" ? "sharing-off" : "setup-offer");
      throw new Error("Location sharing requires setup.");
    }} messageForError={errorMessage} onChanged={announce} onBack={backToSharing}
    renderPoint={(point) => <InlineLocationMap point={point} ownerId={ownerId} token={token} label="You" />} />;
  if (stage === "setup") {
    const setupVersion = revision.current;
    return <>{results}<LocationSetupFlow {...childConversation} mode="setup" onSetupSkip={dismiss}
      onSetupComplete={() => stillCurrent(setupVersion) ? withPending(continueAfterRecovery) : undefined} />
      {error ? <p role="alert" className="text-sm text-muted-foreground">{error}</p> : null}
      {!childConversation.onConversationText && <Button type="button" variant="outline" disabled={busy} onClick={dismiss}>Close setup</Button>}
    </>;
  }
  if (stage === "setup-offer" || stage === "sharing-off" || stage === "device-paused" || stage === "device-permission") return <>{results}<LocationChatActionCard model={{
    phase: "recovery", title: stage === "setup-offer" ? "Set up Location" : stage === "device-paused" ? "Location updates are paused"
      : stage === "device-permission" ? "Device location" : "Location sharing is off",
    description: stage === "setup-offer" ? "Review your sharing consent and device permissions here, then continue with this action."
      : stage === "device-paused" ? "Resuming updates can also restart any active shares on this device."
        : stage === "device-permission" ? "Check whether this device can get your location."
          : "Turn on Location sharing in Hussh to continue.",
    actions: [{ id: "enable", label: stage === "setup-offer" ? "Start setup" : stage === "device-paused" ? "Resume updates"
      : stage === "device-permission" ? "Check device location" : "Turn on sharing", variant: "primary" }, { id: "cancel", label: "Cancel" }],
    error,
  }} busy={busy} onRecover={(action, event) => {
    if (action === "cancel") { dismiss(); return; }
    if (!event.nativeEvent.isTrusted) return;
    if (stage === "setup-offer") { setStage("setup"); return; }
    void withPending(async (version) => {
      if (stage === "device-paused" || stage === "device-permission") {
        await captureChatLocation();
        if (!stillCurrent(version)) return;
        if (stage === "device-permission") {
          setStandaloneStatus("Device location is available.");
          setStage("settled");
          return;
        }
        updateOneLocationControlState(ownerId, (current) => ({ ...current, paused: false }));
      } else {
        try {
          const outcome = await updateLocationAccountSettings(token, { sharingState: "on" });
          if (!stillCurrent(version)) return;
          LocationAccountSettingsResource.write(ownerId, outcome.settings);
        } catch (caught) {
          if (!stillCurrent(version)) return;
          if (apiErrorCode(caught) !== "LOCATION_SHARING_CONSENT_REQUIRED") throw caught;
          setStage("setup");
          return;
        }
      }
      await continueAfterRecovery(version);
    });
  }} /><LocationChatPermissionRecovery issue={permissionIssue} /></>;
  const retryOrReview = (durationMinutes?: number, durationMode?: "timed" | "until_stopped") => withPending((version) => prepare({
    ...intent, durationHours: durationMinutes ? durationMinutes / 60 : undefined,
    durationMode: durationMode ?? "timed",
  }, selected, version));
  if (stage === "cancelled") return <LocationChatActionCard model={{ phase: "result", title: titles[intent.action], status: "Cancelled" }} />;
  if (stage === "settled" && standaloneStatus) {
    return <LocationChatActionCard model={{ phase: "result", title: titles[intent.action], status: standaloneStatus }} />;
  }
  if (stage === "choose" && choices?.length) {
    const group = currentChoice ?? choices[0];
    if (!group) return null;
    const items = group.targets;
    if (!items.length && intent.action === "view" && intent.people?.length) {
      return <LocationChatActionCard model={{
        phase: "recovery", title: "No active share", subject: { label: group.label },
        actions: [{ id: "ask", label: "Ask for location", variant: "primary" }],
        description: error,
      }} busy={busy} onRecover={(_, event) => {
        if (!event.nativeEvent.isTrusted) return;
        void withPending(async (version) => {
          const next = { ...intent, action: "ask" as const, id: proposal.id };
          const resolved = await resolveMainLocationChoices({ token, ownerId, proposal: next, loadState });
          if (!stillCurrent(version)) return;
          setIntent(next); setSelected([]); setChoices(resolved); setStage("choose");
        });
      }} />;
    }
    return <>
      {results}
      <LocationChatActionCard key={`pick-${chooseIndex}`} model={{
        phase: items.length ? "review" : "recovery", title: titles[intent.action],
        description: items.length ? undefined : group.unavailableReason ?? `No eligible match for ${group.label}. Try a name as it appears in your connections.`,
        ...(items.length ? { confirmLabel: "Continue", choiceLabel: group.label, choices: items.map((item, index) => ({
          id: String(index), label: item.label, detail: item.detail,
        })) } : {}),
        ...(error ? { description: error } : {}),
      } as LocationChatActionModel} busy={busy} onDismiss={dismiss} onConfirm={({ choiceId }) => {
        const target = items[Number(choiceId)];
        if (!target) return;
        selectChoice(target);
      }} />
    </>;
  }
  if (stage === "terms") return <>
    {results}
    <LocationChatActionCard key={intent.id} model={{
      phase: "review", title: titles[intent.action], subject: { label: selected.map((item) => item.label).join(", ") },
      confirmLabel: "Review", description: error,
      duration: {
        kind: intent.action === "extend" || intent.action === "ask_extension" ? "extension" : "duration",
        options: intent.action === "share_live" ? initialDurations : editDurations,
        currentEndAt: selected.length === 1 ? selected[0]?.grant?.expiresAt : undefined,
        allowUntilStopped: intent.action === "set_duration",
      },
    }} busy={busy} onDismiss={dismiss}
      onConfirm={({ durationMinutes, durationMode }) => { void retryOrReview(durationMinutes, durationMode); }} />
  </>;

  const first = plans?.[0];
  if (stage === "review" && plans && first) {
    const label = selected.map((item) => item.label).join(", ") || first.personDisplayLabel || "Location";
    const end = plans.length === 1 ? first.nextExpiresAt ?? undefined : undefined;
    const oldEnd = plans.length === 1 ? first.currentExpiresAt : null;
    const facts = [
      ...(first.durationMode === "until_stopped" ? [{ label: "Duration", value: "Until you stop" }]
        : first.durationHours ? [{ label: intent.action === "extend" || intent.action === "ask_extension" ? "Extra time" : "Duration",
          value: `${Math.round(first.durationHours * 60)} minutes` }] : []),
      ...(plans.length > 1 ? [{ label: "Recipients", value: plans.map((item) => item.personDisplayLabel ||
        selected.find((target) => target.personUserId === item.personUserId)?.label || "Circle member").join(", ") }] : []),
      ...(failedLabels.length ? [{ label: "Couldn’t prepare", value: failedLabels.join(", ") }] : []),
    ];
    return <>
      {results}
      <LocationChatActionCard key={first.planId} model={{
        phase: "review", title: titles[intent.action], subject: { label }, facts, endAt: end, currentEndAt: oldEnd || undefined,
        mode: intent.action === "share_live" ? "live" : undefined,
        description: error ?? (intent.action === "share_live"
          ? Capacitor.isNativePlatform() ? "Background updates depend on this device’s Location permissions." : "Keep this page visible to publish live updates."
          : intent.action === "ask_extension" ? "The current end time stays in effect while approval is pending." : undefined),
        confirmLabel: staleReview ? "Review again" : titles[intent.action],
        confirmTone: intent.action === "stop" || intent.action === "decline" ? "destructive" : "default",
        error: !online && intent.action !== "stop" ? "You’re offline." : undefined,
      }} busy={busy} onDismiss={dismiss} onConfirm={(_, event) => {
        if (!event.nativeEvent.isTrusted) return;
        if (!online && intent.action === "stop") {
          for (const plan of plans) {
            if (!plan.grantId) continue;
            queueLocationStop(ownerId, plan.grantId);
          }
          setSettled((rows) => [...rows, ...plans]);
          setStage("settled");
          return;
        }
        void withPending(async (version) => {
          if (staleReview) {
            await prepare({ ...intent, attemptId: crypto.randomUUID() }, plans.map((plan) => ({
              label: plan.personDisplayLabel || "Recipient", personUserId: plan.personUserId ?? undefined,
              grantId: plan.grantId ?? undefined, requestId: plan.requestId ?? undefined,
              circleId: plan.circleId ?? undefined,
            })), version);
            return;
          }
          await commit(version);
        });
      }} />
      <LocationChatPermissionRecovery issue={permissionIssue} />
    </>;
  }

  if (isReadList(intent.action)) {
    const listed = choices?.[0]?.targets ?? [];
    if (!listed.length) return <LocationChatActionCard model={{
      phase: "result", title: titles[intent.action], status: "Nothing to show yet.",
    }} />;
    return <div aria-label={titles[intent.action]} className="space-y-2">
      {listed.map((target) => {
        const recordId = target.grantId ?? target.requestId;
        if (!recordId) return null;
        const action = target.request ? "ask"
          : target.grant?.recipientUserId === ownerId ? "view"
            : target.grant?.shareKind === "pin" ? "share_pin" : "share_live";
        return renderRecord({
          planId: recordId, status: "executed", action,
          grantId: target.grantId, requestId: target.requestId, personDisplayLabel: target.label,
        }, target);
      })}
    </div>;
  }
  return <>{results}{failedLabels.length ? <p role="status" className="text-sm text-muted-foreground">Couldn’t prepare for {failedLabels.join(", ")}.</p> : null}</>;
}
