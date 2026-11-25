"use client";

import { useLayoutEffect, useMemo } from "react";
import type { GeminiRuntimeSettingsModel } from "@/components/connections/gemini-runtime-settings-card";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import type { NativeDrawerRow, NativeProfilePage } from "@/lib/capacitor/native-drawers";
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
  const selectionKnown = model.hasSavedKey !== null && !model.loadFailed;
  const savedConfigurations = model.savedConfigurations ?? [];

  const rows = new Map<string, () => void | Promise<void>>([
    ["runtime-managed", () => invoke(model.selectManaged, "Using your cloud’s AI.")],
    ["runtime-turn-off-byok", () => invoke(model.deactivateCustomAi, "Using built-in sandbox AI.")],
    ["runtime-byok", () => { if (current() && !model.operationPending()) { model.startAddingProvider("gemini"); setEditorOpen(true); } }],
    ["runtime-openai", () => { if (current() && !model.operationPending()) { setEditorOpen(false); model.startAddingProvider("openai"); } }],
    ["runtime-configure", () => { if (current() && !model.operationPending()) setEditorOpen(true); }],
    ["runtime-remove", () => invoke(model.removeByok, "Your saved Gemini key was removed.")],
    ["runtime-retry", async () => { if (current() && !model.operationPending()) { setNotice(null); await model.refresh(); } }],
  ]);

  for (const config of savedConfigurations) {
    rows.set(`runtime-config-${config.id}`, () =>
      invoke(() => model.activateConfiguration(config.id), `Using ${config.label}.`),
    );
    rows.set(`runtime-remove-${config.id}`, () =>
      invoke(() => model.deleteConfiguration(config.id), `${config.label} removed.`),
    );
  }

  const content: NativeDrawerRow[] = [];
  if (model.privateCloud) {
    content.push({
      id: "runtime-managed",
      label: "Use existing cloud",
      detail: model.placement === "azure" ? "Azure AI" : "Vertex AI",
      enabled: ready,
      selected: selectionKnown && model.mode === "hushh_managed_vertex",
      pending: model.isSaving && model.mode === "hushh_managed_vertex",
    });
  } else if (model.activeConfigId || model.mode === "byok") {
    content.push({
      id: "runtime-turn-off-byok",
      label: "Use built-in sandbox AI",
      detail: "Turn off custom AI; saved keys stay in your vault.",
      enabled: ready,
      pending: model.isSaving,
    });
  } else {
    content.push({
      id: "runtime-builtin-status",
      label: "Built-in sandbox AI",
      detail: "Active automatically",
      enabled: true,
      readOnly: true,
      selected: selectionKnown && model.mode === "hushh_managed_vertex",
    });
  }

  for (const config of savedConfigurations) {
    content.push({
      id: `runtime-config-${config.id}`,
      label: config.label,
      detail:
        config.provider === "gemini"
          ? config.transport === "vertex_api_key"
            ? "Gemini · Google Cloud Vertex"
            : "Gemini · Google AI Studio"
          : "OpenAI",
      enabled: ready,
      selected: selectionKnown && model.activeConfigId === config.id,
      ...(config.provider === "gemini" ? { artworkId: "gemini" as const } : {}),
    });
    content.push({
      id: `runtime-remove-${config.id}`,
      label: `Remove ${config.label}`,
      enabled: ready,
      destructive: true,
      pending: model.isRemoving,
    });
  }

  content.push(
    {
      id: "runtime-byok",
      label: "Add Gemini key",
      detail: "Your key stays locked to you.",
      enabled: ready,
      artworkId: "gemini",
      chevron: true,
    },
    {
      id: "runtime-openai",
      label: "Add OpenAI key",
      detail: "Your key stays locked to you.",
      enabled: ready,
      symbol: "key",
      chevron: true,
    },
  );

  if (model.hasSavedKey === null && !model.loadFailed) {
    content.push({ id: "runtime-loading", label: "Checking your configuration…", enabled: true, readOnly: true });
  }
  if (model.loadFailed || notice) {
    content.push(
      { id: "runtime-outcome", label: notice ?? "Couldn’t load your configuration.", enabled: true, readOnly: true },
      { id: "runtime-retry", label: "Refresh settings", enabled: !busy },
    );
  }

  const page: NativeProfilePage = {
    id: "gemini",
    title: "AI connection",
    sections: [
      { id: "runtime-available", title: "Bring your own AI", rows: content },
      {
        id: "runtime-coming-soon",
        title: "Coming soon",
        rows: RUNTIME_PROVIDER_CATALOG
          .filter((p) => p.availability === "coming_soon" && p.id !== "openai")
          .map((p) => ({
            id: `runtime-provider-${p.id}`,
            label: p.name,
            detail: p.description,
            enabled: true,
            readOnly: true,
          })),
      },
    ],
  };

  const closeEditor = () => { model.cancelEdit(); setEditorOpen(false); };
  return {
    page,
    rows,
    failed,
    pending: () => model.operationPending(),
    formScene: active && editorOpen ? "runtime-provider" as const : null,
    editor: (destinationId?: string) =>
      active && editorOpen && destinationId ? (
        <NativeRuntimeEditor
          model={model}
          owner={owner}
          destinationId={destinationId}
          onClose={closeEditor}
          onFallback={() => { setEditorOpen(false); setFailed(true); }}
        />
      ) : null,
  };
}
