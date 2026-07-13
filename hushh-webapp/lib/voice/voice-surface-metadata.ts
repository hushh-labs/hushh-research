"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import type {
  VoiceSurfaceActionDefinition,
  VoiceSurfaceConceptDefinition,
  VoiceSurfaceControlDefinition,
  VoiceSurfaceDefinition,
  VoiceSurfaceSectionDefinition,
} from "@/lib/voice/voice-types";

export type {
  VoiceSurfaceActionDefinition,
  VoiceSurfaceConceptDefinition,
  VoiceSurfaceControlDefinition,
  VoiceSurfaceDefinition,
  VoiceSurfaceSectionDefinition,
} from "@/lib/voice/voice-types";

export type VoiceSurfaceMetadata = {
  /** Route publisher lease that owns this composed inventory. */
  publisherRouteKey?: string | null;
  surfaceDefinition?: VoiceSurfaceDefinition | null;
  screenId?: string | null;
  title?: string | null;
  purpose?: string | null;
  primaryEntity?: string | null;
  sections?: VoiceSurfaceSectionDefinition[];
  actions?: VoiceSurfaceActionDefinition[];
  controls?: VoiceSurfaceControlDefinition[];
  concepts?: Array<VoiceSurfaceConceptDefinition | string>;
  activeSection?: string | null;
  activeTab?: string | null;
  visibleModules?: string[];
  selectedEntity?: string | null;
  focusedWidget?: string | null;
  modalState?: string | null;
  activeFilters?: string[];
  searchQuery?: string | null;
  selectedObjects?: string[];
  availableActions?: string[];
  busyOperations?: string[];
  screenMetadata?: Record<string, unknown>;
  activeControlId?: string | null;
  lastInteractedControlId?: string | null;
  /** Authored description of the currently mounted interaction layer. */
  interactionLayer?: VoiceInteractionLayerV1 | null;
};

export type VoiceSurfacePublisherRole =
  "route" | "chrome" | "interaction_layer";

export type VoiceInteractionLayerModality = "nonmodal" | "modal" | "blocking";
export type VoiceInteractionLayerLifecycle = "opening" | "open" | "closing";
export type VoiceInteractionLayerAgentContinuity =
  "interactive" | "ambient" | "suppressed";

export type VoiceInteractionLayerOption = {
  id: string;
  label: string;
  actionId?: string | null;
  description?: string | null;
};

/**
 * Redacted, authored facts about a dialog, popover, sheet, or menu.
 *
 * This is context for One and deterministic policy. It is not an action
 * registry: every executable id must still resolve through the generated
 * action gateway and a mounted handler.
 */
export type VoiceInteractionLayerV1 = {
  schemaVersion: "voice_interaction_layer.v1";
  id: string;
  kind: string;
  modality: VoiceInteractionLayerModality;
  lifecycle: VoiceInteractionLayerLifecycle;
  dismissible: boolean;
  dismissActionId?: string | null;
  visibleActionIds: string[];
  visibleControlIds: string[];
  options: VoiceInteractionLayerOption[];
  returnFocusControlId?: string | null;
  blocksUnderlyingActions: boolean;
  agentContinuity: VoiceInteractionLayerAgentContinuity;
};

export type VoiceSurfacePublisherOptions = {
  role?: VoiceSurfacePublisherRole;
  /** Route family at mount time; used only to evict stale interaction layers. */
  routeKey?: string | null;
};

type VoiceSurfaceDefinitionInput = Omit<
  Partial<VoiceSurfaceDefinition>,
  "concepts"
> & {
  concepts?: Array<VoiceSurfaceConceptDefinition | string>;
};

const listeners = new Set<() => void>();
let currentSurfaceMetadata: VoiceSurfaceMetadata | null = null;
type VoiceSurfacePublisherEntry = {
  id: string;
  role: VoiceSurfacePublisherRole;
  routeKey: string | null;
  sequence: number;
  metadata: VoiceSurfaceMetadata | null;
};
const publisherEntries = new Map<string, VoiceSurfacePublisherEntry>();
let publisherSequence = 0;
let activeRouteKey: string | null = null;

function emitChange() {
  listeners.forEach((listener) => listener());
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next || null;
}

function uniqueStrings(values: unknown[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const next = new Set<string>();
  values.forEach((value) => {
    const clean = cleanString(value);
    if (clean) {
      next.add(clean);
    }
  });
  return Array.from(next);
}

function normalizeInteractionLayerOption(
  value: unknown,
): VoiceInteractionLayerOption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const label = cleanString(record.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    actionId: cleanString(record.actionId),
    description: cleanString(record.description),
  };
}

function normalizeInteractionLayer(
  value: unknown,
): VoiceInteractionLayerV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const kind = cleanString(record.kind);
  const modality = cleanString(record.modality);
  const lifecycle = cleanString(record.lifecycle);
  const agentContinuity = cleanString(record.agentContinuity);
  if (
    record.schemaVersion !== "voice_interaction_layer.v1" ||
    !id ||
    !kind ||
    !["nonmodal", "modal", "blocking"].includes(modality || "") ||
    !["opening", "open", "closing"].includes(lifecycle || "") ||
    !["interactive", "ambient", "suppressed"].includes(agentContinuity || "")
  ) {
    return null;
  }
  const requestedDismissible = record.dismissible === true;
  const dismissActionId = requestedDismissible
    ? cleanString(record.dismissActionId)
    : null;
  const dismissible = Boolean(requestedDismissible && dismissActionId);
  return {
    schemaVersion: "voice_interaction_layer.v1",
    id,
    kind,
    modality: modality as VoiceInteractionLayerModality,
    lifecycle: lifecycle as VoiceInteractionLayerLifecycle,
    dismissible,
    dismissActionId,
    visibleActionIds: uniqueStrings(record.visibleActionIds as unknown[]),
    visibleControlIds: uniqueStrings(record.visibleControlIds as unknown[]),
    options: uniqueById(
      Array.isArray(record.options)
        ? record.options
            .map(normalizeInteractionLayerOption)
            .filter((option): option is VoiceInteractionLayerOption =>
              Boolean(option),
            )
        : [],
    ).slice(0, 10),
    returnFocusControlId: cleanString(record.returnFocusControlId),
    blocksUnderlyingActions:
      record.blocksUnderlyingActions === true ||
      modality === "modal" ||
      modality === "blocking",
    agentContinuity: agentContinuity as VoiceInteractionLayerAgentContinuity,
  };
}

function normalizeSectionDefinition(
  value: unknown,
): VoiceSurfaceSectionDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const title = cleanString(record.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    purpose: cleanString(record.purpose),
    summary: cleanString(record.summary),
  };
}

function normalizeActionDefinition(
  value: unknown,
): VoiceSurfaceActionDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const label = cleanString(record.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    actionId: cleanString(record.actionId),
    purpose: cleanString(record.purpose),
    description: cleanString(record.description),
    voiceAliases: uniqueStrings(record.voiceAliases as unknown[]),
  };
}

function normalizeControlDefinition(
  value: unknown,
): VoiceSurfaceControlDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const label = cleanString(record.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    type: cleanString(record.type),
    state: cleanString(record.state),
    purpose: cleanString(record.purpose),
    description: cleanString(record.description),
    actionId: cleanString(record.actionId),
    role: cleanString(record.role),
    voiceAliases: uniqueStrings(record.voiceAliases as unknown[]),
  };
}

function normalizeConceptDefinition(
  value: unknown,
): VoiceSurfaceConceptDefinition | null {
  if (typeof value === "string") {
    const label = cleanString(value);
    if (!label) return null;
    return {
      id: null,
      label,
      description: null,
      explanation: null,
      aliases: [],
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const label = cleanString(record.label);
  const explanation = cleanString(record.explanation);
  const description = cleanString(record.description);
  if (!label) return null;
  return {
    id,
    label,
    description,
    explanation,
    aliases: uniqueStrings(record.aliases as unknown[]),
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const next = new Map<string, T>();
  values.forEach((value) => {
    next.set(value.id, value);
  });
  return Array.from(next.values());
}

function uniqueConcepts(
  values: VoiceSurfaceConceptDefinition[],
): VoiceSurfaceConceptDefinition[] {
  const next = new Map<string, VoiceSurfaceConceptDefinition>();
  values.forEach((value) => {
    const key = value.id || value.label.toLowerCase();
    next.set(key, value);
  });
  return Array.from(next.values());
}

function normalizeSurfaceDefinition(
  definition: VoiceSurfaceDefinitionInput | null | undefined,
): VoiceSurfaceDefinition | null {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  )
    return null;
  const normalized: VoiceSurfaceDefinition = {
    screenId: cleanString(definition.screenId),
    title: cleanString(definition.title),
    purpose: cleanString(definition.purpose),
    primaryEntity: cleanString(definition.primaryEntity),
    sections: uniqueById(
      Array.isArray(definition.sections)
        ? definition.sections
            .map((section) => normalizeSectionDefinition(section))
            .filter((section): section is VoiceSurfaceSectionDefinition =>
              Boolean(section),
            )
        : [],
    ),
    actions: uniqueById(
      Array.isArray(definition.actions)
        ? definition.actions
            .map((action) => normalizeActionDefinition(action))
            .filter((action): action is VoiceSurfaceActionDefinition =>
              Boolean(action),
            )
        : [],
    ),
    controls: uniqueById(
      Array.isArray(definition.controls)
        ? definition.controls
            .map((control) => normalizeControlDefinition(control))
            .filter((control): control is VoiceSurfaceControlDefinition =>
              Boolean(control),
            )
        : [],
    ),
    concepts: uniqueConcepts(
      Array.isArray(definition.concepts)
        ? definition.concepts
            .map((concept) => normalizeConceptDefinition(concept))
            .filter((concept): concept is VoiceSurfaceConceptDefinition =>
              Boolean(concept),
            )
        : [],
    ),
    activeControlId: cleanString(definition.activeControlId),
    lastInteractedControlId: cleanString(definition.lastInteractedControlId),
  };

  const hasMeaningfulContent = Boolean(
    normalized.screenId ||
    normalized.title ||
    normalized.purpose ||
    normalized.primaryEntity ||
    normalized.sections.length ||
    normalized.actions.length ||
    normalized.controls.length ||
    normalized.concepts.length ||
    normalized.activeControlId ||
    normalized.lastInteractedControlId,
  );

  return hasMeaningfulContent ? normalized : null;
}

function mergeSurfaceDefinitions(
  legacySurfaceDefinition: VoiceSurfaceDefinition | null,
  directSurfaceDefinition: VoiceSurfaceDefinition | null,
): VoiceSurfaceDefinition | null {
  if (!legacySurfaceDefinition && !directSurfaceDefinition) return null;
  if (!legacySurfaceDefinition) return directSurfaceDefinition;
  if (!directSurfaceDefinition) return legacySurfaceDefinition;

  return {
    screenId:
      directSurfaceDefinition.screenId ||
      legacySurfaceDefinition.screenId ||
      null,
    title:
      directSurfaceDefinition.title || legacySurfaceDefinition.title || null,
    purpose:
      directSurfaceDefinition.purpose ||
      legacySurfaceDefinition.purpose ||
      null,
    primaryEntity:
      directSurfaceDefinition.primaryEntity ||
      legacySurfaceDefinition.primaryEntity ||
      null,
    sections: uniqueById([
      ...legacySurfaceDefinition.sections,
      ...directSurfaceDefinition.sections,
    ]),
    actions: uniqueById([
      ...legacySurfaceDefinition.actions,
      ...directSurfaceDefinition.actions,
    ]),
    controls: uniqueById([
      ...legacySurfaceDefinition.controls,
      ...directSurfaceDefinition.controls,
    ]),
    concepts: uniqueConcepts([
      ...legacySurfaceDefinition.concepts,
      ...directSurfaceDefinition.concepts,
    ]),
    activeControlId:
      directSurfaceDefinition.activeControlId ||
      legacySurfaceDefinition.activeControlId ||
      null,
    lastInteractedControlId:
      directSurfaceDefinition.lastInteractedControlId ||
      legacySurfaceDefinition.lastInteractedControlId ||
      null,
  };
}

function normalizeSurfaceMetadata(
  metadata: VoiceSurfaceMetadata | null | undefined,
): VoiceSurfaceMetadata | null {
  if (!metadata) return null;
  const directSurfaceDefinition = normalizeSurfaceDefinition({
    screenId: metadata.screenId,
    title: metadata.title,
    purpose: metadata.purpose,
    primaryEntity: metadata.primaryEntity,
    sections: metadata.sections,
    actions: metadata.actions,
    controls: metadata.controls,
    concepts: metadata.concepts,
    activeControlId: metadata.activeControlId,
    lastInteractedControlId: metadata.lastInteractedControlId,
  });
  const surfaceDefinition = mergeSurfaceDefinitions(
    normalizeSurfaceDefinition(metadata.surfaceDefinition),
    directSurfaceDefinition,
  );

  return {
    publisherRouteKey: cleanString(metadata.publisherRouteKey),
    surfaceDefinition,
    screenId: surfaceDefinition?.screenId || null,
    title: surfaceDefinition?.title || null,
    purpose: surfaceDefinition?.purpose || null,
    primaryEntity: surfaceDefinition?.primaryEntity || null,
    sections: surfaceDefinition?.sections || [],
    actions: surfaceDefinition?.actions || [],
    controls: surfaceDefinition?.controls || [],
    concepts: surfaceDefinition?.concepts || [],
    activeSection: cleanString(metadata.activeSection),
    activeTab: cleanString(metadata.activeTab),
    visibleModules: uniqueStrings(metadata.visibleModules),
    selectedEntity: cleanString(metadata.selectedEntity),
    focusedWidget: cleanString(metadata.focusedWidget),
    modalState: cleanString(metadata.modalState),
    activeFilters: uniqueStrings(metadata.activeFilters),
    searchQuery: cleanString(metadata.searchQuery),
    selectedObjects: uniqueStrings(metadata.selectedObjects),
    availableActions: uniqueStrings(metadata.availableActions),
    busyOperations: uniqueStrings(metadata.busyOperations),
    activeControlId:
      surfaceDefinition?.activeControlId ||
      cleanString(metadata.activeControlId),
    lastInteractedControlId:
      surfaceDefinition?.lastInteractedControlId ||
      cleanString(metadata.lastInteractedControlId),
    interactionLayer: normalizeInteractionLayer(metadata.interactionLayer),
    screenMetadata:
      metadata.screenMetadata &&
      typeof metadata.screenMetadata === "object" &&
      !Array.isArray(metadata.screenMetadata)
        ? metadata.screenMetadata
        : {},
  };
}

function mergeMetadataArrays<T extends { id: string }>(
  base: T[] | undefined,
  overlay: T[] | undefined,
  overlayFirst = false,
): T[] {
  if (!overlayFirst) return uniqueById([...(base || []), ...(overlay || [])]);
  const next = new Map<string, T>();
  [...(overlay || []), ...(base || [])].forEach((value) => {
    if (!next.has(value.id)) next.set(value.id, value);
  });
  return Array.from(next.values());
}

function mergeVoiceSurfaceMetadata(
  base: VoiceSurfaceMetadata | null,
  overlay: VoiceSurfaceMetadata | null,
  options: { overlayFirst?: boolean; preserveBaseIdentity?: boolean } = {},
): VoiceSurfaceMetadata | null {
  if (!base) return overlay;
  if (!overlay) return base;
  const overlayFirst = options.overlayFirst === true;
  // A route publisher owns screen identity. Chrome can enrich the active
  // surface but cannot relabel it to the feature body's normal product screen;
  // otherwise a static setup adapter can accidentally publish an off-route
  // action inventory after a child rerender.
  const effectiveOverlay = options.preserveBaseIdentity
    ? {
        ...overlay,
        screenId: base.screenId,
        title: base.title || overlay.title,
        purpose: base.purpose || overlay.purpose,
        primaryEntity: base.primaryEntity || overlay.primaryEntity,
      }
    : overlay;
  const surfaceDefinition = normalizeSurfaceDefinition({
    screenId: effectiveOverlay.screenId || base.screenId,
    title: effectiveOverlay.title || base.title,
    purpose: effectiveOverlay.purpose || base.purpose,
    primaryEntity: effectiveOverlay.primaryEntity || base.primaryEntity,
    sections: mergeMetadataArrays(
      base.sections,
      effectiveOverlay.sections,
      overlayFirst,
    ),
    actions: mergeMetadataArrays(base.actions, effectiveOverlay.actions, overlayFirst),
    controls: mergeMetadataArrays(
      base.controls,
      effectiveOverlay.controls,
      overlayFirst,
    ),
    concepts: uniqueConcepts(
      (overlayFirst
        ? [...(effectiveOverlay.concepts || []), ...(base.concepts || [])]
        : [...(base.concepts || []), ...(effectiveOverlay.concepts || [])]
      )
        .map(normalizeConceptDefinition)
        .filter((concept): concept is VoiceSurfaceConceptDefinition =>
          Boolean(concept),
        ),
    ),
    activeControlId: effectiveOverlay.activeControlId || base.activeControlId,
    lastInteractedControlId:
      effectiveOverlay.lastInteractedControlId || base.lastInteractedControlId,
  });
  return normalizeSurfaceMetadata({
    ...base,
    ...effectiveOverlay,
    surfaceDefinition,
    visibleModules: uniqueStrings(
      overlayFirst
        ? [...(effectiveOverlay.visibleModules || []), ...(base.visibleModules || [])]
        : [...(base.visibleModules || []), ...(effectiveOverlay.visibleModules || [])],
    ),
    activeFilters: uniqueStrings([
      ...(base.activeFilters || []),
      ...(effectiveOverlay.activeFilters || []),
    ]),
    selectedObjects: uniqueStrings([
      ...(base.selectedObjects || []),
      ...(effectiveOverlay.selectedObjects || []),
    ]),
    availableActions: uniqueStrings(
      overlayFirst
        ? [
            ...(effectiveOverlay.availableActions || []),
            ...(base.availableActions || []),
          ]
        : [
            ...(base.availableActions || []),
            ...(effectiveOverlay.availableActions || []),
          ],
    ),
    busyOperations: uniqueStrings([
      ...(base.busyOperations || []),
      ...(effectiveOverlay.busyOperations || []),
    ]),
    screenMetadata: {
      ...(base.screenMetadata || {}),
      ...(effectiveOverlay.screenMetadata || {}),
    },
    interactionLayer: effectiveOverlay.interactionLayer || base.interactionLayer || null,
  });
}

function actionIdForDefinition(action: VoiceSurfaceActionDefinition): string {
  return action.actionId || action.id;
}

function restrictMetadataToInteractionLayer(
  base: VoiceSurfaceMetadata | null,
  layerMetadata: VoiceSurfaceMetadata,
  layer: VoiceInteractionLayerV1,
): VoiceSurfaceMetadata {
  const allowedActionIds = new Set(layer.visibleActionIds);
  if (layer.dismissActionId) allowedActionIds.add(layer.dismissActionId);
  layer.options.forEach((option) => {
    if (option.actionId) allowedActionIds.add(option.actionId);
  });
  const allowedControlIds = new Set(layer.visibleControlIds);
  const actions = (layerMetadata.actions || []).filter((action) =>
    allowedActionIds.has(actionIdForDefinition(action)),
  );
  const controls = (layerMetadata.controls || []).filter(
    (control) =>
      allowedControlIds.has(control.id) &&
      (!control.actionId || allowedActionIds.has(control.actionId)),
  );
  return normalizeSurfaceMetadata({
    ...layerMetadata,
    // Route identity stays stable while the interaction layer changes.
    screenId: base?.screenId || layerMetadata.screenId,
    title: layerMetadata.title || base?.title,
    purpose: layerMetadata.purpose || base?.purpose,
    sections: layerMetadata.sections || [],
    actions,
    controls,
    concepts: layerMetadata.concepts || [],
    visibleModules: layerMetadata.visibleModules || [],
    availableActions: (layerMetadata.availableActions || []).filter((label) =>
      actions.some((action) => action.label === label),
    ),
    modalState: layer.id,
    activeControlId: layerMetadata.activeControlId || controls[0]?.id || null,
    selectedEntity: null,
    activeFilters: [],
    searchQuery: null,
    selectedObjects: [],
    interactionLayer: layer,
    screenMetadata: {
      ...(base?.screenMetadata || {}),
      ...(layerMetadata.screenMetadata || {}),
      active_interaction_layer_id: layer.id,
      active_interaction_layer_kind: layer.kind,
    },
  }) as VoiceSurfaceMetadata;
}

function composePublishedMetadata(): VoiceSurfaceMetadata | null {
  const entries = Array.from(publisherEntries.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
  const routeEntry = [...entries]
    .reverse()
    .find((entry) => entry.role === "route");
  let composed = routeEntry?.metadata || null;
  entries
    .filter((entry) => entry.role === "chrome" && entry.metadata)
    .forEach((entry) => {
      composed = mergeVoiceSurfaceMetadata(composed, entry.metadata, {
        preserveBaseIdentity: true,
      });
    });
  const layerEntry = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.role === "interaction_layer" && entry.metadata?.interactionLayer,
    );
  const layer = layerEntry?.metadata?.interactionLayer;
  if (!layerEntry?.metadata || !layer) {
    return composed
      ? { ...composed, publisherRouteKey: routeEntry?.routeKey || null }
      : null;
  }
  if (layer.blocksUnderlyingActions) {
    return {
      ...restrictMetadataToInteractionLayer(
        composed,
        layerEntry.metadata,
        layer,
      ),
      publisherRouteKey: routeEntry?.routeKey || null,
    };
  }
  const merged = mergeVoiceSurfaceMetadata(composed, layerEntry.metadata, {
    overlayFirst: true,
  });
  return normalizeSurfaceMetadata({
    ...(merged || {}),
    screenId: composed?.screenId || merged?.screenId || null,
    modalState: layer.id,
    interactionLayer: layer,
    publisherRouteKey: routeEntry?.routeKey || null,
    screenMetadata: {
      ...(merged?.screenMetadata || {}),
      active_interaction_layer_id: layer.id,
      active_interaction_layer_kind: layer.kind,
    },
  });
}

function refreshComposedMetadata() {
  currentSurfaceMetadata = composePublishedMetadata();
  emitChange();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentSurfaceMetadata;
}

export function publishVoiceSurfaceMetadata(
  publisherId: string,
  metadata: VoiceSurfaceMetadata | null | undefined,
  options: VoiceSurfacePublisherOptions = {},
) {
  const role = options.role || "route";
  const routeKey = cleanString(options.routeKey);
  if (
    role === "route" &&
    routeKey &&
    activeRouteKey &&
    activeRouteKey !== routeKey
  ) {
    publisherEntries.forEach((entry, id) => {
      if (entry.role === "interaction_layer" && entry.routeKey !== routeKey) {
        publisherEntries.delete(id);
      }
    });
  }
  if (role === "route" && routeKey) activeRouteKey = routeKey;
  publisherSequence += 1;
  publisherEntries.set(publisherId, {
    id: publisherId,
    role,
    routeKey,
    sequence: publisherSequence,
    metadata: normalizeSurfaceMetadata(metadata),
  });
  refreshComposedMetadata();
}

export function clearVoiceSurfaceMetadata(publisherId: string) {
  if (!publisherEntries.delete(publisherId)) return;
  if (publisherEntries.size === 0) {
    activeRouteKey = null;
  } else {
    activeRouteKey =
      [...publisherEntries.values()]
        .sort((left, right) => right.sequence - left.sequence)
        .find((entry) => entry.role === "route" && entry.routeKey)?.routeKey ||
      null;
  }
  refreshComposedMetadata();
}

export function getVoiceSurfaceMetadata(): VoiceSurfaceMetadata | null {
  return currentSurfaceMetadata;
}

export function useVoiceSurfaceMetadata(): VoiceSurfaceMetadata | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePublishVoiceSurfaceMetadata(
  metadata: VoiceSurfaceMetadata | null | undefined,
  options: VoiceSurfacePublisherOptions = {},
) {
  const pathname = usePathname();
  const publisherIdRef = useRef(
    `voice_surface_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  );

  useEffect(() => {
    const publisherId = publisherIdRef.current;
    const routeKey =
      options.routeKey ??
      pathname ??
      (typeof window !== "undefined" ? window.location.pathname : null);
    publishVoiceSurfaceMetadata(publisherId, metadata, {
      role: options.role,
      routeKey,
    });
    return () => {
      clearVoiceSurfaceMetadata(publisherId);
    };
  }, [metadata, options.role, options.routeKey, pathname]);
}

export function useVoiceSurfaceControlTracking() {
  const [activeControlId, setActiveControlId] = useState<string | null>(null);
  const [lastInteractedControlId, setLastInteractedControlId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const resolveControlId = (target: EventTarget | null): string | null => {
      if (!(target instanceof Element)) {
        return null;
      }
      const control = target.closest<HTMLElement>("[data-voice-control-id]");
      const controlId = control?.dataset.voiceControlId?.trim();
      return controlId || null;
    };

    const handleFocusIn = (event: FocusEvent) => {
      setActiveControlId(resolveControlId(event.target));
    };

    const handlePointerDown = (event: PointerEvent) => {
      const controlId = resolveControlId(event.target);
      if (!controlId) {
        return;
      }
      setActiveControlId(controlId);
      setLastInteractedControlId(controlId);
    };

    const handleClick = (event: MouseEvent) => {
      const controlId = resolveControlId(event.target);
      if (!controlId) {
        return;
      }
      setActiveControlId(controlId);
      setLastInteractedControlId(controlId);
    };

    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return {
    activeControlId,
    lastInteractedControlId,
    setActiveControlId,
    setLastInteractedControlId,
  };
}
