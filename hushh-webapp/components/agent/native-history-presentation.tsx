"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeDrawerPresentation, type NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { nativeDrawers, nativeDrawersPlatformEligible, nativeDrawerAcknowledged, type NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { getNativeSessionPrivacyState, subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import type { NativeSessionPrivacyState } from "@/lib/capacitor/session-privacy";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { conversationGroupKey, conversationTimestamp, displayConversationLabel, formatRelativeTime, GROUP_LABELS, GROUP_ORDER, normalizeTitle } from "./agent-history-sidebar";

type HistoryPort = {
  owner: string | null;
  vaultEpoch: number;
  ready: boolean;
  disabled?: boolean;
  open: boolean;
  surface: "one" | "puppy";
  conversations: readonly AgentChatConversation[];
  selected: string | null;
  pending: string | null;
  loading: boolean;
  create: () => void;
  select: (id: string) => void;
  rename: (id: string, title: string) => void | Promise<void>;
  remove: (id: string) => void | Promise<void>;
  setOpen: (open: boolean) => void;
};

/** Explicit private port: IDs are presentation handles, never DOM inference or
 * native routing. Existing workspace callbacks retain all operation authority. */
export function nativeHistoryProjection(port: HistoryPort, handles = new Map<string, string>()): { sections: NativeDrawerSection[]; actions: NativeDrawerActions } {
  const actions: NativeDrawerActions = { rows: new Map(), open: () => port.setOpen(true), close: () => port.setOpen(false) };
  const rows = new Map<string, (typeof port.conversations)[number][]>();
  const now = Date.now();
  for (const conversation of [...port.conversations].sort((a, b) => conversationTimestamp(b) - conversationTimestamp(a))) {
    const group = conversationGroupKey(conversationTimestamp(conversation), now);
    rows.set(group, [...rows.get(group) ?? [], conversation]);
  }
  const callbacks = new Map(actions.rows);
  callbacks.set("new", () => port.create());
  const enabled = port.ready && !port.disabled;
  const sections: NativeDrawerSection[] = [{ id: "create", rows: [{ id: "new", label: "New chat", symbol: "plus", enabled }] }];
  for (const key of GROUP_ORDER) {
    const group = rows.get(key);
    if (!group) continue;
    sections.push({ id: `group-${key}`, title: GROUP_LABELS[key], rows: group.map(conversation => {
      const key = `${port.surface}:${conversation.id}`;
      let id = handles.get(key);
      if (!id) { id = `chat-${crypto.randomUUID()}`; handles.set(key, id); }
      const renameActionId = `${id}-rename`, deleteActionId = `${id}-delete`;
      callbacks.set(id, () => port.select(conversation.id));
      callbacks.set(renameActionId, choice => {
        const title = normalizeTitle(choice.text ?? "");
        if (!title || title.length > 160) return;
        return port.rename(conversation.id, title);
      });
      callbacks.set(deleteActionId, () => port.remove(conversation.id));
      const detail = formatRelativeTime(conversationTimestamp(conversation));
      return { id, label: displayConversationLabel(conversation), ...(detail ? { detail } : {}), renameActionId, deleteActionId,
        enabled, selected: conversation.id === port.selected, pending: conversation.id === port.pending };
    }) });
  }
  return { sections, actions: { ...actions, rows: callbacks } };
}

export function useNativeHistoryPresentation(port: HistoryPort): "web" | "preparing" | "native" | "blocked" {
  const theme = useNativeControlAppearance("secondary");
  const [supported, setSupported] = useState<boolean | null>(() => nativeDrawersPlatformEligible() ? null : false);
  const [phase, setPhase] = useState<"web" | "preparing" | "native" | "blocked">("preparing");
  const [privacy, setPrivacy] = useState<NativeSessionPrivacyState | null>(null);
  const current = useRef({ port, theme });
  current.current = { port, theme };
  const privacyRef = useRef(privacy);
  privacyRef.current = privacy;
  const replica = useRef<{ presentation: NativeDrawerPresentation; update: number; privacy: number; owner: string; epoch: number;
    handles: Map<string, string>; fingerprint: string | null } | null>(null);
  const publish = () => {
    const live = replica.current;
    if (!live || !current.current.theme || !current.current.port.ready || live.owner !== current.current.port.owner || live.epoch !== current.current.port.vaultEpoch || snapshotValidatedAuthSessionOwner()?.userId !== live.owner) return;
    const next = nativeHistoryProjection(current.current.port, live.handles);
    const state = { ...live.presentation.identity, ...current.current.theme,
      privacyGeneration: live.privacy, title: current.current.port.surface === "puppy" ? "Puppy chats" : "Chats",
      open: current.current.port.open, enabled: true, backEnabled: false, searchable: true, loading: current.current.port.loading,
      sections: next.sections };
    const fingerprint = JSON.stringify(state); // Private process-only comparison, never diagnostics or persistence.
    if (fingerprint === live.fingerprint) { live.presentation.refreshActions(next.actions); return; }
    if (live.presentation.publish({ ...state, updateSequence: ++live.update }, next.actions)) live.fingerprint = fingerprint;
  };
  useEffect(() => {
    if (!nativeDrawersPlatformEligible()) return;
    let active = true;
    let observer: Awaited<ReturnType<typeof subscribeNativeSessionPrivacy>> | null = null;
    let observed = 0;
    void subscribeNativeSessionPrivacy(event => {
      if (!active || event.generation < (privacyRef.current?.generation ?? 0)) return;
      observed++;
      privacyRef.current = event; // Invalidate awaited actions before React's commit.
      setPrivacy(event);
    }).then(handle => {
      if (!active) { void handle.remove(); return; }
      observer = handle;
      const ordinal = observed;
      return nativeDrawerAcknowledged(getNativeSessionPrivacyState()).then(state => {
        if (active && ordinal === observed) { privacyRef.current = state; setPrivacy(state); }
      });
    }).catch(() => { if (active) setPhase("blocked"); });
    void nativeDrawerAcknowledged(nativeDrawers.getCapabilities()).then(capability => {
      if (active) setSupported(capability.contractVersion === 1 && capability.supported && capability.wholePresentation && capability.historyActions === true);
    }).catch(() => { if (active) setSupported(false); });
    return () => { active = false; void observer?.remove(); };
  }, []);
  useEffect(() => {
    if (!supported || !port.ready || !port.owner || snapshotValidatedAuthSessionOwner()?.userId !== port.owner || !privacy || privacy.shielded || !privacy.appIsActive) return;
    const identity = createNativeDrawerIdentity("history");
    if (!identity) return;
    const owner = port.owner, epoch = port.vaultEpoch;
    const surface = port.surface;
    let active = true;
    const isCurrent = () => active && current.current.port.ready && current.current.port.owner === owner &&
      snapshotValidatedAuthSessionOwner()?.userId === owner &&
      current.current.port.vaultEpoch === epoch && current.current.port.surface === surface && privacyRef.current?.generation === privacy.generation &&
      !privacyRef.current.shielded && privacyRef.current.appIsActive && nativeDrawerOwnerIsCurrent(identity);
    const presentation = new NativeDrawerPresentation(identity, nativeDrawers, isCurrent, next => {
      if (!active) return;
      setPhase(next === "active" ? "native" : next === "retired" ? "web" : next === "quarantined" ? "blocked" : "preparing");
    });
    const instance = { presentation, update: 0, privacy: privacy.generation, owner, epoch, handles: new Map<string, string>(), fingerprint: null as string | null };
    replica.current = instance;
    setPhase("preparing");
    void (async () => {
      if (await presentation.listen() && isCurrent()) publish();
    })().catch(() => { if (active) { setPhase("blocked"); void presentation.retire(); } });
    return () => {
      active = false;
      if (replica.current === instance) replica.current = null;
      void presentation.retire();
    };
  }, [supported, port.ready, port.owner, port.vaultEpoch, port.surface, privacy?.generation, privacy?.shielded, privacy?.appIsActive]);
  useLayoutEffect(() => { publish(); });
  return supported === false ? "web" : phase;
}
