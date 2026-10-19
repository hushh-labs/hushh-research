"use client";

import { useLayoutEffect, useMemo } from "react";
import type { GeminiRuntimeSettingsModel } from "@/components/connections/gemini-runtime-settings-card";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import type { NativeDrawerRow, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { RUNTIME_PROVIDER_CATALOG } from "@/lib/connections/runtime-provider-catalog";
import { NativeRuntimeEditor } from "./native-runtime-editor";

class NativeRuntimeVisit {
  live = false;
  constructor(readonly owner: string, readonly active: boolean, readonly controller: () => boolean) {}
  start() { this.live = this.active; }
  retire() { this.live = false; }
}

/** Complete Preferences body, not a native trigger covering a web key form. */
export function useNativeRuntimeSettings(model: GeminiRuntimeSettingsModel, owner: string, active: boolean) {
  const controller = model.current;
  const visit = useMemo(() => new NativeRuntimeVisit(owner, active, controller), [owner, active, controller]);
  useLayoutEffect(() => { visit.start(); return () => visit.retire(); }, [visit]);
  const [editorOpen, setEditorOpen] = useOwnerPresentationState(visit, false);
  const [notice, setNotice] = useOwnerPresentationState<string | null>(visit, null);
  const [failed, setFailed] = useOwnerPresentationState(visit, false);
  const current = () => { const p = nativePrivacyObservation().state; return visit.live && model.current() && p?.appIsActive === true && !p.shielded; };
  const busy = model.isSaving || model.isRemoving || model.credentialValidation.status === "checking";
  const invoke = async (operation: () => Promise<boolean>, success: string) => {
    if (!current() || model.operationPending()) return;
    const done = await operation();
    if (current()) setNotice(done ? success : "Couldn’t finish. Refresh these settings before trying again.");
  };
  const ready = active && model.hasSavedKey !== null && !model.loadFailed && !busy;
  const rows: NativeDrawerActions["rows"] = new Map([
    ["runtime-managed", () => invoke(model.selectManaged, "Using Hussh’s AI.")],
    ["runtime-byok", () => { if (current() && !model.operationPending()) { void model.selectByok(); setEditorOpen(true); } }],
    ["runtime-configure", () => { if (current() && !model.operationPending()) setEditorOpen(true); }],
    ["runtime-remove", () => invoke(model.removeByok, "Your saved Gemini key was removed.")],
    ["runtime-retry", async () => { if (current() && !model.operationPending()) { setNotice(null); await model.refresh(); } }],
  ]);
  const content: NativeDrawerRow[] = [
    { id: "runtime-managed", label: "Use Hussh’s AI", detail: "No key needed.", enabled: ready, selected: model.mode === "hushh_managed_vertex", artworkId: "gemini", pending: model.isSaving && model.mode === "hushh_managed_vertex" },
    { id: "runtime-byok", label: "Use my own key", detail: "Your key stays locked to you.", enabled: ready, selected: model.mode === "byok", artworkId: "gemini", chevron: true },
  ];
  if (model.hasSavedKey === null) content.push({ id: "runtime-loading", label: "Checking your configuration…", enabled: true, readOnly: true });
  if (model.loadFailed || notice) content.push({ id: "runtime-outcome", label: notice ?? "Couldn’t load your configuration.", enabled: true, readOnly: true },
    { id: "runtime-retry", label: "Refresh settings", enabled: !busy });
  if (model.mode === "byok") content.push(
    { id: "runtime-key-state", label: "Gemini connection", detail: model.hasSavedKey ? "Saved" : "Not set", enabled: true, readOnly: true },
    { id: "runtime-configure", label: "Configure key", detail: model.transport === "vertex_api_key" ? "Google Cloud Vertex API key" : "Google AI Studio", enabled: ready, chevron: true },
    ...(model.hasSavedKey ? [{ id: "runtime-remove", label: "Remove key", enabled: ready, destructive: true, pending: model.isRemoving }] : []));
  const page: NativeProfilePage = { id: "gemini", title: "Gemini", sections: [{ id: "runtime-available", title: "Available now", rows: content },
    { id: "runtime-coming-soon", title: "Coming soon", rows: RUNTIME_PROVIDER_CATALOG.filter(p => p.availability === "coming_soon")
      .map(p => ({ id: `runtime-provider-${p.id}`, label: p.name, detail: p.description, enabled: true, readOnly: true })) }] };
  const closeEditor = () => { model.cancelEdit(); setEditorOpen(false); };
  return { page, rows, failed, pending: () => model.operationPending(), formScene: active && editorOpen ? "runtime-provider" as const : null,
    editor: (destinationId?: string) => active && editorOpen && destinationId ? <NativeRuntimeEditor model={model} owner={owner} destinationId={destinationId}
      onClose={closeEditor} onFallback={() => { setEditorOpen(false); setFailed(true); }} /> : null };
}
