"use client";

import { Capacitor } from "@capacitor/core";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LocationChatActionCard, type LocationChatActionModel } from "@/components/agent/location-chat-action/location-chat-action-card";
import { LocationChatSharePicker } from "@/components/agent/location-chat-action/location-chat-share-picker";
import { LocationChatPublicShare } from "@/components/agent/location-chat-action/location-chat-public-share";
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
import { isLocationPermissionDeniedError } from "@/lib/one-location/location-readiness";
import { readOneLocationControlState, updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { GOOGLE_MAPS_RENDERER_CONSENT_VERSION } from "@/lib/one-location/map-renderer-consent";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationAccessRequest, OneLocationEncryptedEnvelope, OneLocationState, PlainLocationPoint } from "@/lib/one-location/types";
import { publishOneLocationMapPreferences, useOneLocationMapPreferences } from "@/lib/one-location/use-one-location-map-preferences";
import {
  executeMainLocationPlan, expandMainLocationTarget, prepareMainLocationPlan, resolveMainLocationChoices,
  restoreMainLocationPlans, type MainLocationAction, type MainLocationChoice, type MainLocationPlan,
  type MainLocationProposal, type MainLocationTarget,
} from "@/lib/agent/main-chat-location";
import { ApiError } from "@/lib/services/api-client";

const LiveMap = dynamic(() => import("@/components/one-location/live-map").then((module) => module.LiveMap));
const LocationSetupFlow = dynamic(() => import("@/components/location/setup/location-setup-flow").then((module) => module.LocationSetupFlow), {
  loading: () => <p role="status">Opening Location setup…</p>,
});

const titles: Record<MainLocationAction, string> = {
  share_options: "Share your location", share_public: "Public location link",
  share_live: "Share live location", share_pin: "Send current location", ask: "Ask for location",
  view: "View location", list_shares: "Location shares", list_requests: "Location requests",
  stop: "Stop sharing", set_duration: "Change end time", extend: "Add time",
  ask_extension: "Request extra time", approve: "Approve request", decline: "Decline request",
};
const initialDurations = [15, 60, 480];
const editDurations = [15, 30, 60, 120, 480];
const isReadList = (action: MainLocationAction) => action === "list_shares" || action === "list_requests";
const isPublish = (action: MainLocationAction) => action === "share_live" || action === "share_pin";
const needsTime = (action: MainLocationAction) =>
  action === "share_live" || action === "set_duration" || action === "extend" || action === "ask_extension";

function errorMessage(error: unknown) {
  if (isLocationPermissionDeniedError(error)) return Capacitor.isNativePlatform()
    ? "Allow location in device settings, then try again."
    : "Allow location for ONE in your browser’s site settings, then try again.";
  if (!navigator.onLine) return "You’re offline. Reconnect and try again.";
  if (error instanceof ApiError && error.status >= 500) return "Location is unavailable right now. Try again.";
  return error instanceof Error ? error.message : "Couldn’t complete this Location action. Try again.";
}

async function capturePoint(token: string): Promise<PlainLocationPoint> {
  const [settings, permission] = await Promise.all([
    getLocationAccountSettings(token),
    OneLocationService.getPermissionState().catch(() => null),
  ]);
  const observed = permission?.state === "prompt" ? await OneLocationService.requestLocationPermission() : permission;
  const position = await OneLocationService.captureCurrentPosition({ fresh: true, requireMeasurement: true });
  if (!Number.isFinite(position.latitude) || Math.abs(position.latitude) > 90 ||
      !Number.isFinite(position.longitude) || Math.abs(position.longitude) > 180) {
    throw new Error("Couldn’t get a current position. Try again.");
  }
  return coarsenPoint(position, settings.precision === "approximate" || observed?.precise === false || (position.accuracyM ?? 0) >= 1000
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
  onUnlock: () => void;
  allowReview: boolean;
};

export function LocationChatActionPanel(props: PanelProps) {
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
  return <div ref={node}>{activated ? <LocationChatActionContent {...props} nearViewport={nearViewport} /> : null}</div>;
}

function LocationChatActionContent({ proposal, ownerId, token, onUnlock, allowReview, nearViewport }: PanelProps & { nearViewport: boolean }) {
  const now = useCoarseClock(15_000);
  useSyncExternalStore(subscribeLocationStopQueue, locationStopQueueRevision, () => 0);
  const [intent, setIntent] = useState(proposal);
  const [state, setState] = useState<OneLocationState | null>(null);
  const [choices, setChoices] = useState<MainLocationChoice[] | null>(null);
  const [selected, setSelected] = useState<MainLocationTarget[]>([]);
  const [plans, setPlans] = useState<MainLocationPlan[] | null>(null);
  const [settled, setSettled] = useState<MainLocationPlan[]>([]);
  const [retryRevision, setRetryRevision] = useState(0);
  const [stage, setStage] = useState<"loading" | "choose" | "terms" | "review" | "settled" | "cancelled" | "error" | "sharing-off" | "setup-offer" | "setup" | "device-paused" | "share-menu" | "private-picker" | "public-share">("loading");
  const [error, setError] = useState<string>();
  const [permissionIssue, setPermissionIssue] = useState(false);
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
    void (async () => {
      try {
        const previous = await restoreMainLocationPlans(token, proposal.id);
        if (!alive.current || version !== revision.current) return;
        const completed = previous.filter((plan) => plan.status === "executed");
        const pending = allowReview ? previous.filter((plan) => plan.status === "pending" &&
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
        if (proposal.action === "share_options") { setStage("share-menu"); return; }
        if (proposal.action === "share_public") { setStage("public-share"); return; }
        if (isPublish(proposal.action) && !proposal.people?.length && !proposal.circles?.length) {
          setStage("private-picker");
          return;
        }
        const available = await resolveMainLocationChoices({ token, ownerId, proposal, loadState });
        if (!alive.current || version !== revision.current) return;
        setChoices(available);
        setSelected([]);
        setIntent(proposal);
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
  }, [allowReview, loadState, ownerId, proposal, refresh, retryRevision, token]);

  async function withPending(run: (version: number) => Promise<void>) {
    if (busyRef.current || !token || !ownerId) return;
    if (!online) { setError("You’re offline. Reconnect and try again."); return; }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setPermissionIssue(false);
    const version = revision.current;
    try { await run(version); }
    catch (caught) {
      if (alive.current && version === revision.current) {
        setError(errorMessage(caught));
        setPermissionIssue(isLocationPermissionDeniedError(caught));
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

  async function prepare(next: MainLocationProposal, targets: MainLocationTarget[], version: number, setupReady = false) {
    if (!token || !ownerId) return;
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
    if (startsSharing && next.action !== "share_pin" && readOneLocationControlState(ownerId).paused) {
      setIntent(next);
      setSelected(targets);
      setStage("device-paused");
      return;
    }
    const expanded = (await Promise.all(targets.map((item) => expandMainLocationTarget(token, ownerId, item)))).flat();
    const distinct = [...new Map(expanded.map((item) => [
      item.grantId || item.requestId || item.personUserId, item,
    ])).values()];
    if (!distinct.length) throw new Error("There’s nobody eligible in this audience.");
    let workingTargets = distinct;
    if (next.action === "ask") {
      const snapshot = await loadState();
      if (!stillCurrent(version)) return;
      const incoming = distinct.flatMap((target) => snapshot.receivedGrants.flatMap((grant) =>
        grant.ownerUserId === target.personUserId && grant.status === "active" &&
        (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now())
          ? [{ ...target, grantId: grant.id, grant,
            detail: grant.shareKind === "pin" ? "Current location pin" : grant.expiresAt
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
        const opened = await Promise.allSettled(incoming.map(async (target) => {
          const plan = await prepareMainLocationPlan(token, view, target);
          return executeMainLocationPlan(token, plan.planId);
        }));
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
    const outcomes = await Promise.allSettled(workingTargets.map((item) => prepareMainLocationPlan(token, next, item)));
    if (!stillCurrent(version)) return;
    const prepared = outcomes.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!prepared.length) {
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      throw failure?.reason ?? new Error("No Location actions could be prepared.");
    }
    setFailedLabels(outcomes.flatMap((result, index) => result.status === "rejected" ? [workingTargets[index]?.label ?? "Recipient"] : []));
    setIntent(next);
    if (next.action === "view") {
      const opened = await Promise.all(prepared.map((plan) => executeMainLocationPlan(token, plan.planId)));
      if (!stillCurrent(version)) return;
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

  useEffect(() => {
    if (!allowReview || stage !== "choose" || !chosenOrSingle || !choices?.length) return;
    const next = [...selected, chosenOrSingle];
    if (next.length < choices.length) { setSelected(next); return; }
    void withPending((version) => start(intent, next, version));
    // Only auto-advance exact server-resolved single matches, once per choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, chosenOrSingle, choices, chooseIndex, allowReview]);

  async function commit(version: number) {
    if (!plans || !token || !ownerId) return;
    const pending = plans.filter((plan) => plan.status === "pending");
    if (!pending.length) { setStage("settled"); return; }
    let point = preview;
    if (pending.some((plan) => isPublish(plan.action) && !encryptedAttempts.current.has(plan.planId))) {
      if (!point) point = await capturePoint(token);
      if (Date.now() - Date.parse(point.capturedAt) > 55_000) {
        setPreview(null);
        throw new Error("The position changed or became stale. Capture a fresh preview before trying again.");
      }
    }
    if (!stillCurrent(version)) return;
    const results = await Promise.allSettled(pending.map(async (plan) => {
      let envelope = encryptedAttempts.current.get(plan.planId);
      if (!envelope && isPublish(plan.action)) {
        if (!point || !plan.recipientKey) throw new Error("The recipient’s secure location key is unavailable.");
        const precision = point.precision ?? "precise";
        const encrypted = await encryptLocationForRecipient({
          point, recipientKeyId: plan.recipientKey.keyId, recipientPublicKeyJwk: plan.recipientKey.publicKeyJwk,
        });
        envelope = { ...encrypted, metadata: { precision }, publicationContext: "foreground_map_visible" };
        encryptedAttempts.current.set(plan.planId, envelope);
      }
      if (!stillCurrent(version)) throw new Error("The chat changed before this action could be sent.");
      return executeMainLocationPlan(token, plan.planId, envelope);
    }));
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

  const viewIds = settled.filter((plan) => plan.action === "view").flatMap((plan) => {
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
        const next = await Promise.allSettled(ids.map(async (id) => {
          const response = await OneLocationService.viewEnvelope({ vaultOwnerToken: token!, grantId: id });
          return [id, response.envelope ? await decryptLocationEnvelope({ userId: ownerId!, envelope: response.envelope }) : null] as const;
        }));
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

  function follow(action: MainLocationAction, target: MainLocationTarget) {
    const next = { id: proposal.id, attemptId: crypto.randomUUID(), action };
    void withPending((version) => start(next, [target], version));
  }

  if (!ownerId || !token) return <LocationChatActionCard model={{
    phase: "recovery", title: "Unlock Location in this chat",
    description: "Unlock your vault to review the Location action.",
    actions: [{ id: "unlock", label: "Unlock vault", variant: "primary" }],
  }} onRecover={onUnlock} />;
  if (!allowReview && stage === "cancelled" && !settled.length) return null;
  if (stage === "loading") return <LocationChatActionCard model={{ phase: "result", title: titles[intent.action], status: "Getting Location details…" }} busy />;
  if (stage === "error") return <LocationChatActionCard model={{
    phase: "recovery", title: titles[intent.action], error,
    actions: [{ id: "retry", label: "Try again", variant: "primary" }],
  }} onRecover={() => setRetryRevision((value) => value + 1)} />;

  function renderRecord(plan: MainLocationPlan) {
    const { grant, request, id } = snapshotFor(state, plan);
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
      title: titles[plan.action],
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

  const dismiss = () => { setStage(settled.length ? "settled" : "cancelled"); setPreview(null); };
  const results = settled.map(renderRecord);
  const backToSharing = () => {
    setError(undefined);
    setStage("share-menu");
  };
  if (stage === "share-menu") return <LocationChatActionCard model={{
    phase: "recovery", title: "Share your location", description: "Who should be able to open your location?",
    actions: [{ id: "private", label: "Share privately", variant: "primary" }, { id: "public", label: "Create a public link" }],
  }} onRecover={(action) => setStage(action === "private" ? "private-picker" : "public-share")} />;
  if (stage === "private-picker") return <LocationChatSharePicker token={token} ownerId={ownerId} busy={busy} error={error}
    initialMode={proposal.action === "share_pin" ? "share_pin" : "share_live"} onBack={backToSharing}
    onContinue={(action, targets) => {
      void withPending((version) => start({
        ...proposal, action, people: undefined, circles: undefined,
        ...(action === "share_pin" ? { durationHours: undefined, durationMode: undefined } : {}),
      }, targets, version));
    }} />;
  if (stage === "public-share") return <LocationChatPublicShare token={token} ownerId={ownerId} initialHours={proposal.durationHours}
    loadState={loadState} capture={async () => {
      const settings = await getLocationAccountSettings(token);
      if (settings.sharing_state === "on") return capturePoint(token);
      setIntent({ ...proposal, action: "share_public" });
      setSelected([]);
      setStage(settings.sharing_state === "off" ? "sharing-off" : "setup-offer");
      throw new Error("Location sharing requires setup.");
    }} messageForError={errorMessage} onChanged={announce} onBack={backToSharing}
    renderPoint={(point) => <InlineLocationMap point={point} ownerId={ownerId} token={token} label="You" />} />;
  if (stage === "setup") return <>{results}<LocationSetupFlow mode="setup" onSetupSkip={dismiss}
    onSetupComplete={() => withPending((version) => prepare(intent, selected, version, true))} />
    {error ? <p role="alert" className="text-sm text-muted-foreground">{error}</p> : null}</>;
  if (stage === "setup-offer" || stage === "sharing-off" || stage === "device-paused") return <>{results}<LocationChatActionCard model={{
    phase: "recovery", title: stage === "setup-offer" ? "Set up Location" : stage === "device-paused" ? "Location updates are paused" : "Location sharing is off",
    description: stage === "setup-offer" ? "Review your sharing consent and device permissions here, then continue with this action."
      : stage === "device-paused" ? "Resuming updates can also restart any active shares on this device."
        : "Turn on Location sharing in ONE to continue. You’ll still review who can see this share and for how long.",
    actions: [{ id: "enable", label: stage === "setup-offer" ? "Start setup" : stage === "device-paused" ? "Resume updates" : "Turn on sharing", variant: "primary" }, { id: "cancel", label: "Cancel" }],
    error,
  }} busy={busy} onRecover={(action, event) => {
    if (action === "cancel") { dismiss(); return; }
    if (!event.nativeEvent.isTrusted) return;
    if (stage === "setup-offer") { setStage("setup"); return; }
    void withPending(async (version) => {
      if (stage === "device-paused") updateOneLocationControlState(ownerId, (current) => ({ ...current, paused: false }));
      else {
        const outcome = await updateLocationAccountSettings(token, { sharingState: "on" });
        LocationAccountSettingsResource.write(ownerId, outcome.settings);
      }
      if (stillCurrent(version)) await prepare(intent, selected, version, true);
    });
  }} /></>;
  const retryOrReview = (durationMinutes?: number, durationMode?: "timed" | "until_stopped") => withPending((version) => prepare({
    ...intent, durationHours: durationMinutes ? durationMinutes / 60 : undefined,
    durationMode: durationMode ?? "timed",
  }, selected, version));
  if (stage === "cancelled") return <LocationChatActionCard model={{ phase: "result", title: titles[intent.action], status: "Cancelled" }} />;
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
        description: items.length ? undefined : `No eligible match for ${group.label}. Try a name as it appears in your connections.`,
        ...(items.length ? { confirmLabel: "Continue", choiceLabel: group.label, choices: items.map((item, index) => ({
          id: String(index), label: item.label, detail: item.detail,
        })) } : {}),
        ...(error ? { description: error } : {}),
      } as LocationChatActionModel} busy={busy} onDismiss={dismiss} onConfirm={({ choiceId }) => {
        const target = items[Number(choiceId)];
        if (!target) return;
        const next = [...selected, target];
        if (next.length < choices.length) setSelected(next);
        else void withPending((version) => start(intent, next, version));
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
    const previewRequired = intent.action === "share_pin" && !preview && !encryptedAttempts.current.has(first.planId);
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
        mode: intent.action === "share_pin" ? "current" : intent.action === "share_live" ? "live" : undefined,
        description: error ?? (intent.action === "share_live"
          ? Capacitor.isNativePlatform() ? "Background updates depend on this device’s Location permissions." : "Keep this page visible to publish live updates."
          : intent.action === "ask_extension" ? "The current end time stays in effect while approval is pending." : undefined),
        confirmLabel: staleReview ? "Review again" : previewRequired ? "Preview current location" : titles[intent.action],
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
          if (previewRequired) {
            const point = await capturePoint(token);
            if (stillCurrent(version)) setPreview(point);
            return;
          }
          await commit(version);
        });
      }} map={preview ? <InlineLocationMap point={preview} ownerId={ownerId} token={token} label="You" /> : undefined} />
      {permissionIssue && Capacitor.isNativePlatform() ? <Button variant="outline" type="button" onClick={(event) => {
        if (event.nativeEvent.isTrusted) void OneLocationService.openAppSettings().catch(() => undefined);
      }}>Open device settings</Button> : null}
    </>;
  }

  if (isReadList(intent.action)) {
    const listed = choices?.[0]?.targets ?? [];
    const single = listed.length === 1 ? listed[0] : undefined;
    return <LocationChatActionCard model={{
      phase: "active", title: titles[intent.action],
      status: listed.length ? undefined : "Nothing to show yet.",
      facts: listed.map((item) => {
        const updatedRequest: OneLocationAccessRequest | undefined = state?.requests.find((row) => row.id === item.requestId);
        const updatedGrant = state ? [...state.ownerGrants, ...state.receivedGrants].find((row) => row.id === item.grantId) : undefined;
        return { label: item.label, value: updatedRequest?.status ?? (updatedGrant?.expiresAt
          ? `${updatedGrant.status} · Until ${new Date(updatedGrant.expiresAt).toLocaleString()}` : updatedGrant?.status ?? item.detail ?? "Available") };
      }),
      actions: single?.request?.ownerUserId === ownerId && single?.request?.status === "pending"
        ? [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] : [],
    }} onRecover={(action, event) => { if (single && event.nativeEvent.isTrusted) follow(action as MainLocationAction, single); }} />;
  }
  return <>{results}{failedLabels.length ? <p role="status" className="text-sm text-muted-foreground">Couldn’t prepare for {failedLabels.join(", ")}.</p> : null}</>;
}
