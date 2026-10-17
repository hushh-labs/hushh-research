"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationSosVoiceDefaultAction } from "@/lib/one-location/types";
import { ConnectionsService } from "@/lib/services/connections-service";

export type VoiceLocationDefaults = {
  autoApproveRequests: boolean;
  nearbyCheckInVisible: boolean;
  nearbyCheckInAllowConnectionRequests: boolean;
  sosDefaultAction: OneLocationSosVoiceDefaultAction;
};
type LocationEndpoint = "autoApprove" | "nearby" | "sos";
type LoadStatus = "loading" | "ready" | "unavailable";
type LocationSnapshot = { defaults: VoiceLocationDefaults | null; pending: ReadonlySet<LocationEndpoint>; status: LoadStatus };
const emptyLocation: LocationSnapshot = { defaults: null, pending: new Set(), status: "unavailable" };

/** Feature-local operation owner, not persistence or a native replica. Each
 * instance is bound to one authority. Retained commands cannot target its
 * replacement. Requests never run in a React updater or during construction. */
function locationModel(owner: string | null, token: string | null) {
  let snapshot: LocationSnapshot = owner && token ? { ...emptyLocation, status: "loading" } : emptyLocation;
  let generation = 0, active = false;
  const listeners = new Set<() => void>();
  const publish = (next: LocationSnapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
  const current = (run: number) => active && run === generation;
  const write = (endpoint: LocationEndpoint, patch: Partial<VoiceLocationDefaults>,
    request: (value: VoiceLocationDefaults, vaultOwnerToken: string) => Promise<unknown>): Promise<boolean> => {
    if (!active || !token || !snapshot.defaults || snapshot.pending.has(endpoint)) return Promise.resolve(false);
    const run = generation, previous = snapshot.defaults;
    const submitted = { ...previous, ...patch };
    publish({ defaults: submitted, pending: new Set([...snapshot.pending, endpoint]), status: "ready" });
    return Promise.resolve().then(() => current(run) ? request(submitted, token) : Promise.reject())
      .then(() => current(run), () => {
        if (current(run) && snapshot.defaults) {
          const rollback = Object.fromEntries(Object.keys(patch).map(key => [key, previous[key as keyof VoiceLocationDefaults]]));
          publish({ ...snapshot, defaults: { ...snapshot.defaults, ...rollback } });
        }
        return false;
      }).finally(() => {
        if (!current(run)) return;
        const pending = new Set(snapshot.pending); pending.delete(endpoint);
        publish({ ...snapshot, pending });
      });
  };
  const read = () => {
      const run = ++generation;
      active = !!owner && !!token; publish({ ...emptyLocation, status: active ? "loading" : "unavailable" });
      if (active && token) void OneLocationService.getState(token).then(state => {
        if (!current(run)) return;
        publish({ status: "ready", pending: new Set(), defaults: {
          autoApproveRequests: Boolean(state.autoApprovePreference?.enabled),
          nearbyCheckInVisible: state.nearbyCheckInPreferences?.visible ?? true,
          nearbyCheckInAllowConnectionRequests: state.nearbyCheckInPreferences?.allowConnectionRequests ?? false,
          sosDefaultAction: state.sosVoicePreference?.defaultAction ?? "open",
        } });
      }).catch(() => { if (current(run)) publish(emptyLocation); });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload: () => { if (active && snapshot.status === "unavailable" && !snapshot.pending.size) read(); },
    start: () => {
      read();
      return () => { active = false; ++generation; publish(emptyLocation); };
    },
    setAutoApprove: (enabled: boolean) => write("autoApprove", { autoApproveRequests: enabled }, (_, vaultOwnerToken) =>
      OneLocationService.updateAutoApprovePreference({ vaultOwnerToken, enabled, scope: enabled ? { kind: "all_contacts" } : undefined })),
    setNearby: (patch: Partial<Pick<VoiceLocationDefaults, "nearbyCheckInVisible" | "nearbyCheckInAllowConnectionRequests">>) =>
      write("nearby", patch, (value, vaultOwnerToken) => OneLocationService.updateNearbyCheckInPreferences({
        vaultOwnerToken, visible: value.nearbyCheckInVisible, allowConnectionRequests: value.nearbyCheckInAllowConnectionRequests,
      })),
    setSos: (defaultAction: OneLocationSosVoiceDefaultAction) => write("sos", { sosDefaultAction: defaultAction }, (_, vaultOwnerToken) =>
      OneLocationService.updateSosVoicePreference({ vaultOwnerToken, defaultAction })),
  };
}

export function useVoiceLocationDefaults(owner: string | null, token: string | null) {
  const model = useMemo(() => locationModel(owner, token), [owner, token]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  return { ...snapshot, reload: model.reload, setAutoApprove: model.setAutoApprove, setNearby: model.setNearby, setSos: model.setSos };
}

type ConnectSnapshot = { shareScopes: boolean | null; pending: boolean; status: LoadStatus };
const emptyConnect: ConnectSnapshot = { shareScopes: null, pending: false, status: "unavailable" };
function connectModel(owner: string | null, getIdToken: (() => Promise<string>) | null) {
  let snapshot: ConnectSnapshot = owner && getIdToken ? { ...emptyConnect, status: "loading" } : emptyConnect;
  let generation = 0, active = false;
  const listeners = new Set<() => void>();
  const publish = (next: ConnectSnapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
  const current = (run: number) => active && run === generation;
  const read = () => {
      const run = ++generation;
      active = !!owner && !!getIdToken; publish({ ...emptyConnect, status: active ? "loading" : "unavailable" });
      if (active && getIdToken) void getIdToken().then(idToken => current(run) ? ConnectionsService.getVoicePreferences({ idToken }) : null)
        .then(value => { if (value && current(run)) publish({ shareScopes: value.shareScopesFromLastRequest, pending: false, status: "ready" }); })
        .catch(() => { if (current(run)) publish(emptyConnect); });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload: () => { if (active && snapshot.status === "unavailable" && !snapshot.pending) read(); },
    start: () => {
      read();
      return () => { active = false; ++generation; publish(emptyConnect); };
    },
    setShareScopes: async (checked: boolean): Promise<boolean> => {
      if (!active || !getIdToken || snapshot.pending || snapshot.shareScopes === null) return false;
      const run = generation, previous = snapshot.shareScopes;
      publish({ shareScopes: checked, pending: true, status: "ready" });
      try {
        const idToken = await getIdToken();
        if (!current(run)) return false;
        await ConnectionsService.updateVoicePreferences({ idToken, shareScopesFromLastRequest: checked });
        return current(run);
      } catch {
        if (current(run)) publish({ shareScopes: previous, pending: true, status: "ready" });
        return false;
      } finally {
        if (current(run)) publish({ ...snapshot, pending: false });
      }
    },
  };
}

export function useVoiceConnectDefaults(owner: string | null, getIdToken: (() => Promise<string>) | null) {
  const model = useMemo(() => connectModel(owner, getIdToken), [owner, getIdToken]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  return { ...snapshot, reload: model.reload, setShareScopes: model.setShareScopes };
}
