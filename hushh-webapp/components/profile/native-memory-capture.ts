import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { PrivateProfileEditorModel } from "@/lib/capacitor/native-profile-private-editor";
import { validWorkspaceMemoryDraft, type NativeWorkspaceMemoryDraft } from "@/lib/capacitor/native-workspace";
import {
  describeAgentPkmCardDestination,
  formatAgentPkmCardDestination,
  getIgnoredPkmCards,
} from "@/lib/agent/agent-pkm-memory";
import { describePkmCaptureSection } from "@/lib/pkm/pkm-capture-sections";
import type { PkmNaturalModel } from "./use-pkm-natural-model";

/** A presentation projection only. The Memory model remains the sole owner of
 * note edits, approval, review, retry and save. Handles are visit-scoped and
 * opaque; they must not expose record IDs or source text to the bridge. */
export type NativeMemoryCaptureModel = Pick<PkmNaturalModel,
  | "captureText" | "identifierProcessingApproved" | "setIdentifierProcessingApproval"
  | "captureCards" | "domainTitles" | "captureMessage" | "captureLoading" | "captureSaving"
  | "captureHasUnresolvedSource" | "captureUnresolvedSections" | "captureSourceSnapshot"
  | "captureRetryingSectionKey" | "retryCaptureSection" | "captureHasSharedRecipients"
  | "captureSharingImpactAcknowledged" | "setCaptureSharingImpactAcknowledged"
  | "captureSaveableCards" | "previewMemoryCapture" | "saveMemoryCapture" | "changeCaptureText"
  | "captureInputRevision" | "captureSessionCurrent"
>;

export type NativeMemoryCaptureProjection = {
  draft: { text: string; identifierApproved: boolean };
  /** Review loading does not lock note editing: changing text cancels that result. */
  busy: boolean;
  reviewing: boolean;
  canToggleIdentifier: boolean;
  canReview: boolean;
  sections: readonly NativeDrawerSection[];
  actions: ReadonlyMap<string, () => void | Promise<unknown>>;
  /** Consent is bound to the currently rendered note, never a new draft. */
  applyDraft: (draft: { text: string; identifierApproved: boolean }) => void;
  review: () => Promise<void>;
};

/** Return null instead of clipping private content or omitting an action when
 * the bounded workspace bridge cannot represent this state. The caller then
 * retains the complete React presentation until retirement is confirmed. */
export function nativeMemoryCapture(
  model: NativeMemoryCaptureModel,
  handle: (key: string) => string,
): NativeMemoryCaptureProjection | null {
  if (model.captureText.length > 50_000) return null;
  const rows: NativeDrawerRow[] = [];
  const actions = new Map<string, () => void | Promise<unknown>>();
  const identifiers = new Set<string>();
  let representable = true;
  const row = (key: string, label: string, detail?: string, action?: () => void | Promise<unknown>,
    options: Pick<NativeDrawerRow, "selected" | "enabled" | "pending"> = { enabled: true }) => {
    const id = handle(`memory-capture:${key}`);
    if (!id || id.length > 128 || identifiers.has(id) || !label || label.length > 4096 || (detail?.length ?? 0) > 4096) representable = false;
    identifiers.add(id);
    if (action) actions.set(id, action);
    rows.push({ id, label, ...(detail ? { detail } : {}), enabled: options.enabled,
      ...(options.selected !== undefined ? { selected: options.selected } : {}),
      ...(options.pending !== undefined ? { pending: options.pending } : {}),
      ...(!action ? { readOnly: true } : {}) });
  };

  if (model.captureLoading) row("status-loading", "Preparing Memory…");
  if (model.captureMessage) row("status-message", model.captureMessage);
  model.captureCards.forEach((card, index) => {
    const destination = describeAgentPkmCardDestination(card, model.domainTitles);
    const sharing = card.sharing_impact?.active_recipient_count
      ? card.sharing_impact.summary?.trim() || "This may update a detail that is currently shared."
      : "This stays private unless you choose to share it later.";
    const detail = [formatAgentPkmCardDestination(destination), destination.kind === "not_saved" ? null : sharing]
      .filter(Boolean).join("\n");
    row(`proposal-${index}`, card.source_text?.trim().replace(/\s*\n+\s*/g, " · ") || "Proposed saved detail", detail);
  });
  if (getIgnoredPkmCards(model.captureCards).length > 0) {
    row("ignored", "Some of this note will not be saved", "Only appropriate details can be added to Memory.");
  }
  if (model.captureHasUnresolvedSource) model.captureUnresolvedSections.forEach((block, index) => {
    const section = describePkmCaptureSection(model.captureSourceSnapshot, block);
    row(`unresolved-${index}`, section.label, `${section.reason} Nothing from this section has been saved.`);
    if (section.retryable) {
      const retrying = model.captureRetryingSectionKey === section.key;
      row(`retry-${index}`, "Retry this section", undefined, () => model.retryCaptureSection(block), {
        enabled: !model.captureLoading && !model.captureSaving && model.captureRetryingSectionKey === null,
        pending: retrying,
      });
    }
  });
  if (model.captureHasSharedRecipients) {
    row("sharing-ack", "I understand that this detail is already shared and will be refreshed for the current recipients.",
      "Review this before saving. It does not change who can access the detail.",
      () => model.setCaptureSharingImpactAcknowledged(!model.captureSharingImpactAcknowledged),
      { enabled: !model.captureSaving, selected: model.captureSharingImpactAcknowledged });
  }
  if (model.captureCards.length > 0) {
    row("save", model.captureSaving ? "Saving…" : "Save to Memory", undefined, () => model.saveMemoryCapture(), {
      enabled: !model.captureSaving && model.captureSaveableCards.length > 0 && model.captureRetryingSectionKey === null &&
        (!model.captureHasSharedRecipients || model.captureSharingImpactAcknowledged),
      pending: model.captureSaving,
    });
  }
  const sectionId = handle("memory-capture:results");
  if (!sectionId || sectionId.length > 128 || identifiers.has(sectionId) || rows.length > 200 || !representable) return null;
  return {
    draft: { text: model.captureText, identifierApproved: model.identifierProcessingApproved() },
    busy: model.captureSaving,
    reviewing: model.captureLoading,
    canToggleIdentifier: !model.captureLoading && !model.captureSaving,
    canReview: !model.captureLoading && !model.captureSaving && !!model.captureText.trim(),
    sections: rows.length ? [{ id: sectionId, rows }] : [],
    actions,
    applyDraft: next => {
      if (next.text !== model.captureText) {
        // The model clears approval and the old preview when text changes.
        // A simultaneous native approval must not grant it to new text.
        model.changeCaptureText(next.text);
        return;
      }
      if (next.identifierApproved !== model.identifierProcessingApproved()) {
        model.setIdentifierProcessingApproval(next.identifierApproved);
      }
    },
    review: model.previewMemoryCapture,
  };
}

/** Adapt the retained Memory owner to the existing workspace editor. Its
 * revision is the feature's real input revision, not a native-side copy. */
export function nativeMemoryCaptureEditor(
  model: NativeMemoryCaptureModel,
  projection: NativeMemoryCaptureProjection,
  destinationId: string,
  current: () => boolean,
): PrivateProfileEditorModel<NativeWorkspaceMemoryDraft> & {
  destinationId: string; canToggleIdentifier: boolean; reviewing: boolean;
  onReview: () => Promise<void>; onSaved: () => void; onCancel: () => void;
} {
  const isCurrent = () => current() && model.captureSessionCurrent();
  return {
    destinationId,
    draft: projection.draft,
    busy: projection.busy,
    reviewing: projection.reviewing,
    canToggleIdentifier: projection.canToggleIdentifier,
    canSave: projection.canReview,
    error: null,
    current: isCurrent,
    inputRevision: model.captureInputRevision,
    mutationPending: () => model.captureSaving,
    changeDraft: (draft, expectedRevision) => {
      if (!isCurrent() || model.captureSaving || !validWorkspaceMemoryDraft(draft) ||
        expectedRevision !== model.captureInputRevision()) return false;
      const changedText = draft.text !== model.captureText;
      // The workspace retains the accepted draft until React commits. Reject a
      // combined text+approval event so that replica cannot display approval
      // for text the owner never approved.
      if (changedText && draft.identifierApproved) return false;
      if (!changedText && draft.identifierApproved !== model.identifierProcessingApproved() &&
        !projection.canToggleIdentifier) return false;
      projection.applyDraft(draft);
      return true;
    },
    save: model.saveMemoryCapture,
    onReview: projection.review,
    // This inline editor has no independent save/cancel transition; its
    // existing Memory model owns review, final save and route navigation.
    onSaved: () => undefined,
    onCancel: () => undefined,
  };
}
