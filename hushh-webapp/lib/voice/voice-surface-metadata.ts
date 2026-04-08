"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
};

type VoiceSurfaceDefinitionInput = Omit<Partial<VoiceSurfaceDefinition>, "concepts"> & {
  concepts?: Array<VoiceSurfaceConceptDefinition | string>;
};

const listeners = new Set<() => void>();
let currentSurfaceMetadata: VoiceSurfaceMetadata | null = null;
let currentPublisherId: string | null = null;

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

function normalizeSectionDefinition(value: unknown): VoiceSurfaceSectionDefinition | null {
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

function normalizeActionDefinition(value: unknown): VoiceSurfaceActionDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const label = cleanString(record.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    purpose: cleanString(record.purpose),
    description: cleanString(record.description),
    voiceAliases: uniqueStrings(record.voiceAliases as unknown[]),
  };
}

function normalizeControlDefinition(value: unknown): VoiceSurfaceControlDefinition | null {
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

function normalizeConceptDefinition(value: unknown): VoiceSurfaceConceptDefinition | null {
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

function uniqueConcepts(values: VoiceSurfaceConceptDefinition[]): VoiceSurfaceConceptDefinition[] {
  const next = new Map<string, VoiceSurfaceConceptDefinition>();
  values.forEach((value) => {
    const key = value.id || value.label.toLowerCase();
    next.set(key, value);
  });
  return Array.from(next.values());
}

function normalizeSurfaceDefinition(
  definition: VoiceSurfaceDefinitionInput | null | undefined
): VoiceSurfaceDefinition | null {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return null;
  const normalized: VoiceSurfaceDefinition = {
    screenId: cleanString(definition.screenId),
    title: cleanString(definition.title),
    purpose: cleanString(definition.purpose),
    primaryEntity: cleanString(definition.primaryEntity),
    sections: uniqueById(
      Array.isArray(definition.sections)
        ? definition.sections
            .map((section) => normalizeSectionDefinition(section))
            .filter((section): section is VoiceSurfaceSectionDefinition => Boolean(section))
        : []
    ),
    actions: uniqueById(
      Array.isArray(definition.actions)
        ? definition.actions
            .map((action) => normalizeActionDefinition(action))
            .filter((action): action is VoiceSurfaceActionDefinition => Boolean(action))
        : []
    ),
    controls: uniqueById(
      Array.isArray(definition.controls)
        ? definition.controls
            .map((control) => normalizeControlDefinition(control))
            .filter((control): control is VoiceSurfaceControlDefinition => Boolean(control))
        : []
    ),
    concepts: uniqueConcepts(
      Array.isArray(definition.concepts)
        ? definition.concepts
            .map((concept) => normalizeConceptDefinition(concept))
            .filter((concept): concept is VoiceSurfaceConceptDefinition => Boolean(concept))
        : []
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
      normalized.lastInteractedControlId
  );

  return hasMeaningfulContent ? normalized : null;
}

function mergeSurfaceDefinitions(
  legacySurfaceDefinition: VoiceSurfaceDefinition | null,
  directSurfaceDefinition: VoiceSurfaceDefinition | null
): VoiceSurfaceDefinition | null {
  if (!legacySurfaceDefinition && !directSurfaceDefinition) return null;
  if (!legacySurfaceDefinition) return directSurfaceDefinition;
  if (!directSurfaceDefinition) return legacySurfaceDefinition;

  return {
    screenId: directSurfaceDefinition.screenId || legacySurfaceDefinition.screenId || null,
    title: directSurfaceDefinition.title || legacySurfaceDefinition.title || null,
    purpose: directSurfaceDefinition.purpose || legacySurfaceDefinition.purpose || null,
    primaryEntity:
      directSurfaceDefinition.primaryEntity || legacySurfaceDefinition.primaryEntity || null,
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
      directSurfaceDefinition.activeControlId || legacySurfaceDefinition.activeControlId || null,
    lastInteractedControlId:
      directSurfaceDefinition.lastInteractedControlId ||
      legacySurfaceDefinition.lastInteractedControlId ||
      null,
  };
}

function normalizeSurfaceMetadata(
  metadata: VoiceSurfaceMetadata | null | undefined
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
    directSurfaceDefinition
  );

  return {
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
    activeControlId: surfaceDefinition?.activeControlId || cleanString(metadata.activeControlId),
    lastInteractedControlId:
      surfaceDefinition?.lastInteractedControlId ||
      cleanString(metadata.lastInteractedControlId),
    screenMetadata:
      metadata.screenMetadata &&
      typeof metadata.screenMetadata === "object" &&
      !Array.isArray(metadata.screenMetadata)
        ? metadata.screenMetadata
        : {},
  };
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
  metadata: VoiceSurfaceMetadata | null | undefined
) {
  currentPublisherId = publisherId;
  currentSurfaceMetadata = normalizeSurfaceMetadata(metadata);
  emitChange();
}

export function clearVoiceSurfaceMetadata(publisherId: string) {
  if (currentPublisherId !== publisherId) return;
  currentPublisherId = null;
  currentSurfaceMetadata = null;
  emitChange();
}

export function getVoiceSurfaceMetadata(): VoiceSurfaceMetadata | null {
  return currentSurfaceMetadata;
}

export function useVoiceSurfaceMetadata(): VoiceSurfaceMetadata | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePublishVoiceSurfaceMetadata(
  metadata: VoiceSurfaceMetadata | null | undefined
) {
  const publisherIdRef = useRef(
    `voice_surface_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  );

  useEffect(() => {
    const publisherId = publisherIdRef.current;
    publishVoiceSurfaceMetadata(publisherId, metadata);
    return () => {
      clearVoiceSurfaceMetadata(publisherId);
    };
  }, [metadata]);
}

export function useVoiceSurfaceControlTracking() {
  const [activeControlId, setActiveControlId] = useState<string | null>(null);
  const [lastInteractedControlId, setLastInteractedControlId] = useState<string | null>(null);

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
