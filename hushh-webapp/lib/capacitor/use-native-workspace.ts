"use client";

import { boundNativeWalletArtwork } from "./native-wallet-workspace";
import { retainNativeFeedbackSink, dismissNativeSinkFeedback, activateNativeSinkFeedback,
  type NativePresentationFeedback, type NativeFeedbackScope } from "./native-feedback-sink";
import { refreshNativeFeedback, retargetNativeSinkToastToWeb } from "./native-feedback";
import { validNativeWalletProfileDraft, type NativeWalletProfileDraft } from "./native-wallet-profile-editor";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { NativeWorkspacePresentationOwner, setNativeWorkspacePresentationOwner, type NativeWorkspacePhase, type NativeWorkspaceReason } from "./native-workspace-presence";
import { captureNativeDrawerOwner, nativeDrawerOwnerIsCurrent } from "./native-drawer-owner";
import { nativeDrawers, nativeDrawerAcknowledged, subscribeNativeDrawerIsolation, nativeDrawerIsolation, observeNativeDrawerIsolation, trackNativeWorkspaceRetirement, nativeWorkspaceRetirementBarrier } from "./native-drawers";
import { nativePrivacyCanInteract, nativePrivacyObservation, subscribeNativePrivacyObservation } from "./session-privacy";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "../vault/session-epoch";
import { nativeColorTokenHex, useNativeControlAppearance } from "./native-control-appearance";
import { workspaceChoiceDomainAllowed, nativeWorkspaceFrameFromAnchors, sameNativeWorkspace, validNativeWorkspace, validWorkspaceCircleDraft, validWorkspaceMemoryDraft, validWorkspaceTaskDraft, validWorkspaceTextDraft, type NativeWorkspaceTextDraft, type NativeWorkspaceTaskDraft, workspaceAcknowledged, type NativeWorkspaceIdentity, type NativeWorkspaceFrame, type NativeWorkspaceProjection, type NativeWorkspaceReceipt, type NativeWorkspaceChoice, type NativeWorkspacePort, type NativeWorkspaceCircleDraft, type NativeWorkspaceMemoryDraft, type NativeWorkspaceEdit, type NativeWorkspaceFinalEdit } from "./native-workspace";
import type { PrivateProfileEditorModel } from "./native-profile-private-editor";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "./native-navigation";

export type NativeWorkspaceContent = Pick<NativeWorkspaceProjection, "workspace" | "navigation" | "page" | "title" | "enabled" | "backEnabled" | "sections" | "tabs" | "secondaryTabs" | "search" | "wallet" | "launcher" | "calendarDate">;
type WorkspaceDraft = NativeWorkspaceTextDraft | NativeWorkspaceCircleDraft | NativeWalletProfileDraft | NativeWorkspaceMemoryDraft | NativeWorkspaceTaskDraft;
export type WorkspaceEditor<D extends WorkspaceDraft> = PrivateProfileEditorModel<D> & { destinationId: string; onSaved?: () => void; readDraft?: () => D; finalCurrent?: () => boolean; reconcileFinal?: (draft: D, expectedRevision: number) => boolean; onCancel: () => void; customTypes?: readonly string[]; canToggleIdentifier?: boolean; reviewing?: boolean; onReview?: () => Promise<void>; textLabels?: Pick<NonNullable<NativeWorkspaceProjection["textEditor"]>, "label" | "placeholder" | "maximum" | "submitLabel" | "cancelLabel" | "format"> };
let nextRevision = 0, nextLayout = 0;

export function useNativeWorkspacePresentation() {
  const [owner] = useState(() => new NativeWorkspacePresentationOwner());
  const status = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return { owner, status, retireForWeb: owner.retireForWeb };
}

/** One route body admission. No feature readers, writers, router or per-frame
 * synchronization live here. Uncertain retirement never exposes a duplicate. */
export function useNativeWorkspace<D extends WorkspaceDraft = NativeWorkspaceCircleDraft>({ owner, content, actions, back, current, editor, onRetirementOwner, contentFrame, editorKind = "circle", presentationOwner, active: routeActive = true, covered = false, activationRevision = 0 }: {
  owner: string; content: NativeWorkspaceContent; actions: ReadonlyMap<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>;
  back: () => void; current: () => boolean;
  editor?: WorkspaceEditor<D>;
  editorKind?: "circle" | "wallet-profile" | "memory" | "task" | "text";
  onRetirementOwner?: (revoke: () => Promise<boolean>) => void;
  contentFrame?: RefObject<HTMLElement | null>;
  presentationOwner?: NativeWorkspacePresentationOwner;
  active?: boolean;
  covered?: boolean;
  /** Explicitly retry admission after an owned web handoff was cancelled. */
  activationRevision?: number;
}) {
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const vaultEpoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const isolation = useSyncExternalStore(observeNativeDrawerIsolation, nativeDrawerIsolation, nativeDrawerIsolation);
  const webCovered = useNativeShellOverlayBlocked();
  const [phase, setPhaseState] = useState<NativeWorkspacePhase>(() => customNativePresentationEnabled() ? "checking" : "web");
  const lifetime = useRef<NativeWorkspaceIdentity | null>(null);
  const lastRetirementReason = useRef<NativeWorkspaceReason>("inactive");
  const temporarilyCovered = covered || webCovered;
  const wasCovered = useRef(temporarilyCovered);
  const [admissionRevision, setAdmissionRevision] = useState(0);
  useLayoutEffect(() => {
    if (wasCovered.current && !temporarilyCovered && lastRetirementReason.current === "web-overlay") {
      lastRetirementReason.current = "inactive";
      setAdmissionRevision(value => value + 1);
    }
    wasCovered.current = temporarilyCovered;
  }, [temporarilyCovered]);
  const [, setAcknowledgement] = useState(0);
  const live = useRef({ owner, content, actions, back, current, appearance, privacy, editor, onRetirementOwner });
  useLayoutEffect(() => { live.current = { owner, content, actions, back, current, appearance, privacy, editor, onRetirementOwner }; });
  const publish = useRef<() => void>(() => {});
  useLayoutEffect(() => { publish.current(); });
  // Layout cleanup precedes the persistent shell's next layout publish. A
  // passive cleanup registers withdrawal too late for that same-commit handoff.
  useLayoutEffect(() => {
    if (!customNativePresentationEnabled() || !routeActive) {
      if (!presentationOwner?.getSnapshot().held) setPhaseState("web");
      return;
    }
    const base = captureNativeDrawerOwner();
    if (!base || !privacy?.appIsActive || privacy.shielded) return;
    const identity: NativeWorkspaceIdentity = { ...base, revision: ++nextRevision, workspace: content.workspace };
    lifetime.current = identity;
    setPhaseState("checking");
    const setPhase = (next: NativeWorkspacePhase, reason: NativeWorkspaceReason = next === "native" ? "active" : "failure") => {
      presentationOwner?.report(identity, next, reason);
      if (lifetime.current === identity) setPhaseState(next);
    };
    const generation = privacy.generation;
    let active = true, started = false, retired = false, withdrawing = false, running = false, sequence = 0, consumed = 0;
    let withdrawal: Promise<boolean> | undefined, retirementRequests = 0;
    let handle: PluginListenerHandle | undefined, isolationHandle: PluginListenerHandle | undefined, editHandle: PluginListenerHandle | undefined, finalHandle: PluginListenerHandle | undefined;
    let observer: ResizeObserver | undefined, frame: NativeWorkspaceFrame | undefined;
    let applied: NativeWorkspaceProjection | undefined, desired: NativeWorkspaceProjection | undefined, fingerprint = "";
    let port: NativeWorkspacePort | undefined;
    const edits = new Map<string, { revision: number; modelRevision: number; composing: boolean; discarded: boolean; model: WorkspaceEditor<D>; draft?: D }>();
    const issuedDrafts = new Map<number, { destinationId: string; revision: number }>();
    let acceptFinal = true;
    const releaseFinal = () => { if (!acceptFinal) return; acceptFinal = false; void finalHandle?.remove().catch(() => undefined); edits.clear(); stopEpoch(); stopPrivacy(); window.removeEventListener("pagehide", releaseFinal); };
    const finalOwnerCurrent = () => live.current.owner === owner && nativeDrawerOwnerIsCurrent(base) && snapshotVaultSessionEpoch() === vaultEpoch;
    const checkFinalOwner = () => { if (!finalOwnerCurrent()) releaseFinal(); };
    const stopEpoch = subscribeVaultSessionEpoch(checkFinalOwner), stopPrivacy = subscribeNativePrivacyObservation(checkFinalOwner);
    window.addEventListener("pagehide", releaseFinal);
    const isCurrent = () => active && !withdrawing && !retired && live.current.owner === owner && live.current.current() && nativeDrawerOwnerIsCurrent(base) &&
      snapshotVaultSessionEpoch() === vaultEpoch && live.current.privacy?.generation === generation && live.current.privacy.appIsActive && !live.current.privacy.shielded;
    let feedback: { key: string; message: NativePresentationFeedback } | null = null;
    const feedbackKey = (scope: NativeFeedbackScope = "presentation") => {
      const currentPrivacy = nativePrivacyObservation().state;
      const leaseCurrent = !retired && nativeDrawerOwnerIsCurrent(base) && snapshotVaultSessionEpoch() === vaultEpoch &&
        currentPrivacy?.generation === generation && currentPrivacy.appIsActive && !currentPrivacy.shielded &&
        (withdrawing || isCurrent() && !nativeShellOverlayBlocked());
      if (!leaseCurrent) return null;
      if (scope === "workspace") return JSON.stringify([identity, generation, "workspace"]);
      if (!live.current.content.enabled || !live.current.content.wallet?.selectedId && nativeDrawerIsolation().isolated) return null;
      return JSON.stringify([identity, generation, live.current.content.page, live.current.content.wallet?.detailVisitId]);
    };
    const feedbackCurrent = (key: string) => key === feedbackKey() || key === feedbackKey("workspace");
    const feedbackVisible = (key: string) => !withdrawing && feedbackCurrent(key) && (key !== feedbackKey("workspace") || live.current.content.enabled && (!!live.current.content.wallet?.selectedId || !nativeDrawerIsolation().isolated));
    const releaseFeedback = retainNativeFeedbackSink({ capture: feedbackKey,
      ready: key => feedbackVisible(key) && applied === desired,
      show: (key, message) => { if (feedbackVisible(key)) { feedback = { key, message }; emit(); } },
      hide: (key, id) => { if (feedback?.key === key && feedback.message.id === id) { feedback = null; emit(); } },
      retargetToWeb: retargetNativeSinkToastToWeb,
    });
    refreshNativeFeedback();
    const retireOnce = async () => {
      if (retired) return true;
      if (!started || !port) { retired = true; return true; }
      const workspacePort = port;
      const confirmsRetirement = (value: unknown): value is NativeWorkspaceReceipt => {
        if (!value || typeof value !== "object" || Array.isArray(value) || !("phase" in value)) return false;
        const receipt = value as NativeWorkspaceReceipt;
        return sameNativeWorkspace(receipt, identity) && receipt.phase === "retired" && receipt.settled === true &&
          Number.isSafeInteger(receipt.updateSequence) && receipt.updateSequence >= 0 && receipt.updateSequence <= sequence;
      };
      const confirmsActive = (value: unknown): value is NativeWorkspaceReceipt => {
        if (!value || typeof value !== "object" || Array.isArray(value) || !("phase" in value)) return false;
        const receipt = value as NativeWorkspaceReceipt;
        return sameNativeWorkspace(receipt, identity) && receipt.phase === "active" && receipt.settled === true &&
          Number.isSafeInteger(receipt.updateSequence) && receipt.updateSequence >= 0 && receipt.updateSequence <= sequence;
      };
      const requestRetirement = async () => {
        retirementRequests++;
        try {
          const receipt = await nativeDrawerAcknowledged(workspacePort.retireWorkspace(identity));
          retired = confirmsRetirement(receipt);
        } catch { /* Only a matching exact-state read can authorize one retry. */ }
      };
      if (retirementRequests === 0) await requestRetirement();
      if (!retired) {
        // Readback only first. A retry is permitted once, and only if that
        // readback proves this exact workspace is still active and settled.
        let state: unknown;
        try { state = await nativeDrawerAcknowledged(workspacePort.getWorkspaceState(identity)); retired = confirmsRetirement(state); }
        catch { retired = false; }
        if (!retired && retirementRequests < 2 && confirmsActive(state)) {
          await requestRetirement();
          if (!retired) {
            try { retired = confirmsRetirement(await nativeDrawerAcknowledged(workspacePort.getWorkspaceState(identity))); }
            catch { retired = false; }
          }
        }
      }
      return retired;
    };
    const retire = () => {
      withdrawing = true; desired = undefined; applied = undefined; fingerprint = "";
      if (!withdrawal) {
        const attempt = retireOnce();
        let tracked: Promise<boolean>;
        tracked = attempt.finally(() => {
          if (retired) setNativeWorkspacePresentationOwner(identity, false);
          // A later user route action can re-read this exact identity if the
          // first state receipt was still unsettled or unavailable.
          if (!retired && withdrawal === tracked) withdrawal = undefined;
        });
        withdrawal = tracked;
        trackNativeWorkspaceRetirement(identity, tracked, port);
      }
      return withdrawal;
    };
    const fail = (error: unknown = "NATIVE_WORKSPACE_FAILED") => {
      if (lifetime.current === identity) {
        const message = typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? String(error.message) : "";
        document.documentElement.dataset.nativeWorkspaceLastFailure = JSON.stringify({ workspace: content.workspace,
          code: message.length <= 96 && /^NATIVE_WORKSPACE_[A-Z_]+$/.test(message) ? message : "NATIVE_WORKSPACE_FAILED" });
      }
      return revoke("failure");
    };
    const flush = async () => {
      if (running || !port || !desired || !isCurrent()) return;
      running = true;
      try {
        while (desired && desired !== applied && isCurrent()) {
          const state = desired;
          if (!validNativeWorkspace(state)) throw new Error("NATIVE_WORKSPACE_INVALID");
          // A native host may install before its apply receipt settles. Hold
          // Web notices through admission, updates, and exact retirement.
          setNativeWorkspacePresentationOwner(identity, true);
          started = true;
          const receipt = await nativeDrawerAcknowledged(port.applyWorkspace(state));
          if (!workspaceAcknowledged(receipt, state, "active")) throw new Error("NATIVE_WORKSPACE_UNCONFIRMED");
          applied = state;
          if (isCurrent()) { setPhase("native"); refreshNativeFeedback(); }
        }
      } catch (error) { if (isCurrent()) await fail(error); }
      finally { running = false; }
    };
    const emit = () => {
      const value = live.current;
      if (!isCurrent() || !value.appearance || !frame || retired) return;
      // A DOM modal temporarily owns the presentation. Its existing overlay
      // token, rather than a permanent renderer failure, gates readmission.
      if (nativeShellOverlayBlocked()) { void revoke("web-overlay"); return; }
      let circleEditor: (Omit<NonNullable<NativeWorkspaceProjection["circleEditor"]>, "draft"> & { draft: D }) | undefined;
      let memoryDraftCommitted = true;
      if (value.editor?.current()) {
        const editor = value.editor;
        let accepted = edits.get(editor.destinationId);
        if (!accepted) { accepted = { revision: 0, modelRevision: editor.inputRevision(), composing: false, discarded: false, model: editor }; edits.set(editor.destinationId, accepted); }
        accepted.model = editor;
        const draftRevision = editor.inputRevision();
        // Acknowledgement can render before the feature's React draft commits.
        // Pair that revision with the accepted input, never the older render.
        const draft = accepted.modelRevision === draftRevision && accepted.draft ? accepted.draft : editor.draft;
        // Review reads the React owner's captured note. Do not admit the tap
        // until that render contains the exact draft already acknowledged to
        // native, including its identifier-processing approval.
        const acceptedMemoryDraft = accepted.draft as NativeWorkspaceMemoryDraft | undefined;
        const renderedMemoryDraft = editor.draft as NativeWorkspaceMemoryDraft;
        const reviewDraftCommitted = !["memory", "text"].includes(editorKind) || !accepted.draft ||
          acceptedMemoryDraft?.text === renderedMemoryDraft.text &&
          (editorKind === "text" || acceptedMemoryDraft.identifierApproved === renderedMemoryDraft.identifierApproved);
        memoryDraftCommitted = reviewDraftCommitted;
        circleEditor = { destinationId: editor.destinationId, draft: { ...draft }, draftRevision, acknowledgedEditRevision: accepted.revision,
          canSave: editor.canSave && !accepted.composing && reviewDraftCommitted, busy: editor.busy, error: editor.error,
          ...(editorKind === "circle" && editor.customTypes ? { customTypes: editor.customTypes } : {}) };
      }
      const canvasHex = nativeColorTokenHex("--background");
      const next = boundNativeWalletArtwork({ ...identity, ...value.appearance, ...value.content, ...(canvasHex ? { canvasHex } : {}), ...(feedback && feedbackVisible(feedback.key) ? { feedback: feedback.message } : {}), frame, privacyGeneration: generation, isolationGeneration: nativeDrawerIsolation().generation,
        ...(circleEditor ? editorKind === "circle" ? { circleEditor: circleEditor as NativeWorkspaceProjection["circleEditor"] } : editorKind === "wallet-profile" ? { walletProfileEditor: circleEditor as NativeWorkspaceProjection["walletProfileEditor"] } : editorKind === "task" ? { taskEditor: circleEditor as NativeWorkspaceProjection["taskEditor"] } : editorKind === "text" ? { textEditor: { ...circleEditor, ...value.editor?.textLabels } as NativeWorkspaceProjection["textEditor"] } : { memoryEditor: { ...circleEditor, canToggleIdentifier: value.editor?.canToggleIdentifier === true && memoryDraftCommitted, reviewing: value.editor?.reviewing === true } as NativeWorkspaceProjection["memoryEditor"] } : {}) });
      const key = JSON.stringify(next); // Private replica, never diagnostics.
      if (key === fingerprint) return;
      fingerprint = key; desired = { ...next, updateSequence: ++sequence };
      if (circleEditor) issuedDrafts.set(sequence, { destinationId: circleEditor.destinationId, revision: circleEditor.draftRevision });
      while (issuedDrafts.size > 32) issuedDrafts.delete(issuedDrafts.keys().next().value!);
      void flush();
    };
    publish.current = emit;
    const acceptEdit = (event: NativeWorkspaceEdit | NativeWorkspaceFinalEdit, final: boolean) => {
      if (final && !acceptFinal) return;
      const keys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "workspace", "destinationId", "updateSequence", "privacyGeneration", "editRevision", "composing", "draft", ...(final ? ["baseDraftRevision"] : [])];
      if (!sameNativeWorkspace(event, identity) || event.privacyGeneration !== generation || !Number.isSafeInteger(event.editRevision) || event.editRevision < 0 ||
        Object.keys(event).some(key => !keys.includes(key)) ||
        !Number.isSafeInteger(event.updateSequence) || event.updateSequence <= 0 || event.updateSequence > sequence || typeof event.composing !== "boolean" ||
        !(editorKind === "circle" ? validWorkspaceCircleDraft(event.draft) : editorKind === "wallet-profile" ? validNativeWalletProfileDraft(event.draft) : editorKind === "task" ? validWorkspaceTaskDraft(event.draft) : editorKind === "text" ? validWorkspaceTextDraft(event.draft) : validWorkspaceMemoryDraft(event.draft)) || !nativeDrawerOwnerIsCurrent(base) || snapshotVaultSessionEpoch() !== vaultEpoch) return;
      const accepted = edits.get(event.destinationId);
      if (!accepted || accepted.discarded || !(final ? (accepted.model.finalCurrent ?? accepted.model.current)() : accepted.model.current()) || event.editRevision <= accepted.revision) return;
      if (!final && (!isCurrent() || live.current.editor?.destinationId !== event.destinationId)) return;
      const revision = accepted.model.inputRevision();
      if (!final) {
        const issued = issuedDrafts.get(event.updateSequence);
        if (!issued || issued.destinationId !== event.destinationId || revision !== issued.revision && revision !== accepted.modelRevision) { void fail(); return; }
      }
      if (final && (!("baseDraftRevision" in event) || event.composing || !Number.isSafeInteger(event.baseDraftRevision) ||
        revision !== event.baseDraftRevision && revision !== accepted.modelRevision)) return;
      if (!(final && accepted.model.reconcileFinal ? accepted.model.reconcileFinal(event.draft as D, revision) : accepted.model.changeDraft(event.draft as D, revision))) return;
      accepted.revision = event.editRevision; accepted.modelRevision = accepted.model.inputRevision(); accepted.composing = event.composing;
      accepted.draft = { ...(accepted.model.readDraft?.() ?? event.draft) } as D;
      // Composition-only changes need an explicit acknowledgement too. Keep
      // the model's current draft in the replica until React's next commit.
      if (active) setAcknowledgement(value => value + 1);
      if (final) { edits.delete(event.destinationId); if (!active && !edits.size) releaseFinal(); }
    };
    const choose = async (choice: NativeWorkspaceChoice) => {
      if (!port || !sameNativeWorkspace(choice, identity) || !Number.isSafeInteger(choice.sequence) || choice.sequence <= consumed) return;
      consumed = choice.sequence;
      try {
        // Native may emit immediately after presenting, before the apply
        // receipt reaches JavaScript. Never execute such a choice, but do
        // settle its exact lease so the retained workspace remains usable.
        if (!applied || !isCurrent() || choice.privacyGeneration !== generation) return;
        const state = applied;
        const isolationGeneration = nativeDrawerIsolation().generation;
        const admission = await nativeDrawerAcknowledged(port.confirmWorkspaceChoice(choice));
        const terminalDismissal = choice.dismissed === true && choice.domain === "wallet-detail" && choice.rowId === state.wallet?.closeId &&
          choice.detailVisitId === state.wallet?.detailVisitId && desired?.wallet?.detailVisitId === choice.detailVisitId && live.current.content.wallet?.detailVisitId === choice.detailVisitId;
        // Keyboard clearance may publish while acknowledgement is in flight.
        // Discard belongs to the same editor lifetime, not that layout snapshot.
        const currentTextCancellation = () => choice.action === "text-cancel" && !!state.textEditor &&
          choice.updateSequence <= (applied?.updateSequence ?? 0) &&
          live.current.editor?.destinationId === state.textEditor.destinationId &&
          applied?.textEditor?.destinationId === state.textEditor.destinationId &&
          desired?.textEditor?.destinationId === state.textEditor.destinationId;
        if (admission.valid && isCurrent() && (terminalDismissal || currentTextCancellation() || applied === state && desired === state && state.updateSequence === choice.updateSequence) &&
          nativeDrawerIsolation().generation === isolationGeneration && workspaceChoiceDomainAllowed(choice, state, nativeDrawerIsolation().isolated) && !nativeShellOverlayBlocked()) {
          if (choice.action === "feedback-dismiss" && typeof choice.rowId === "string" && choice.rowId === state.feedback?.id) {
            dismissNativeSinkFeedback(choice.rowId, "user");
          } else if (choice.action === "feedback-action" && typeof choice.rowId === "string" &&
            choice.rowId === state.feedback?.id && choice.actionToken === state.feedback.actionToken) {
            activateNativeSinkFeedback(choice.rowId, choice.actionToken);
          }
          else if (choice.action === "memory-review") {
            const editor = live.current.editor, accepted = editor && edits.get(editor.destinationId);
            if (!editor?.current() || !accepted || accepted.composing || accepted.revision !== choice.editRevision ||
                editor.mutationPending() || !editor.canSave || !editor.onReview) return;
            // The existing Memory owner fences late review results when the
            // draft changes. Settle this native tap without locking editing.
            void editor.onReview().catch(() => { if (isCurrent()) console.warn("NATIVE_MEMORY_REVIEW_FAILED"); });
          } else if (choice.action === "text-save" || choice.action === "text-cancel" || choice.action === "circle-save" || choice.action === "circle-cancel" || choice.action === "wallet-save" || choice.action === "wallet-cancel" || choice.action === "task-save" || choice.action === "task-cancel") {
            const editor = live.current.editor, accepted = editor && edits.get(editor.destinationId);
            if (!editor?.current() || !accepted || editor.mutationPending() ||
                choice.action !== "text-cancel" && (accepted.composing || accepted.revision !== choice.editRevision)) return;
            if (choice.action === "text-cancel" || choice.action === "circle-cancel" || choice.action === "wallet-cancel" || choice.action === "task-cancel") { accepted.discarded = true; editor.onCancel(); }
            else if (editor.canSave && await editor.save() && isCurrent() && live.current.editor?.destinationId === editor.destinationId) {
              accepted.discarded = true; live.current.editor.onSaved?.();
            }
          } else {
            const callback = choice.action === "back" && state.backEnabled ? () => live.current.back() : choice.action === "row" && choice.rowId ? live.current.actions.get(choice.rowId) : undefined;
            await callback?.(choice);
          }
        }
      } finally { await nativeDrawerAcknowledged(port.settleWorkspaceChoice(choice)).catch(() => undefined); }
    };
    const revoke = async (reason: NativeWorkspaceReason = "inactive") => {
      if (lifetime.current === identity) lastRetirementReason.current = reason;
      active = false; feedback = null; if (lifetime.current === identity) publish.current = () => {}; desired = undefined; fingerprint = "";
      observer?.disconnect(); void handle?.remove(); void editHandle?.remove(); void isolationHandle?.remove();
      const retirement = retire();
      refreshNativeFeedback();
      const absent = await retirement;
      const currentPrivacy = nativePrivacyObservation().state;
      const safeWebFallback = absent && nativePrivacyCanInteract(currentPrivacy) && currentPrivacy?.generation === generation &&
        snapshotVaultSessionEpoch() === vaultEpoch;
      releaseFeedback(absent && safeWebFallback);
      refreshNativeFeedback();
      if (absent || !finalOwnerCurrent()) releaseFinal();
      setPhase(absent ? "web" : "blocked", reason);
      return absent;
    };
    presentationOwner?.register(identity, revoke);
    live.current.onRetirementOwner?.(revoke);
    void (async () => {
      try {
        if (presentationOwner && !await presentationOwner.retirePredecessors(identity)) {
          if (isCurrent()) setPhase("blocked", "inactive");
          return;
        }
        if (!isCurrent()) return;
        // Another route owns a different presentation owner. Its exact native
        // retirement still has to finish before this route can be admitted.
        const previousRoute = nativeWorkspaceRetirementBarrier();
        if (previousRoute && !await previousRoute) {
          if (isCurrent()) setPhase("blocked", "inactive");
          return;
        }
        if (!isCurrent()) return;
        const plugin = nativeDrawers();
        const capabilities = await nativeDrawerAcknowledged(plugin.getCapabilities());
        if (!isCurrent()) return;
        if (capabilities.contractVersion !== 1 || !capabilities.supported || !capabilities.routeWorkspaces?.includes(content.workspace) ||
          !plugin.applyWorkspace || !plugin.retireWorkspace || !plugin.confirmWorkspaceChoice || !plugin.settleWorkspaceChoice || !plugin.getWorkspaceState) { await revoke("unsupported"); return; }
        port = { applyWorkspace: plugin.applyWorkspace.bind(plugin), retireWorkspace: plugin.retireWorkspace.bind(plugin),
          confirmWorkspaceChoice: plugin.confirmWorkspaceChoice.bind(plugin), settleWorkspaceChoice: plugin.settleWorkspaceChoice.bind(plugin), getWorkspaceState: plugin.getWorkspaceState.bind(plugin) };
        handle = await plugin.addListener("workspaceChoice", value => { void choose(value).catch(() => undefined); });
        editHandle = await plugin.addListener("workspaceEdit", value => acceptEdit(value, false));
        finalHandle = await plugin.addListener("workspaceFinalEdit", value => acceptEdit(value, true));
        if (!acceptFinal) void finalHandle.remove().catch(() => undefined);
        isolationHandle = await subscribeNativeDrawerIsolation(plugin);
        if (!isCurrent()) return;
        const seat = document.querySelector<HTMLElement>('[data-native-workspace-seat="true"]');
        if (!seat) throw new Error("NATIVE_WORKSPACE_SEAT_MISSING");
        const measure = () => {
          const seatBounds = seat.getBoundingClientRect();
          const authored = contentFrame?.current;
          const shellBounds = authored?.getBoundingClientRect() ?? seatBounds;
          const style = authored ? getComputedStyle(authored) : null;
          const left = style ? Number.parseFloat(style.paddingLeft) : 16;
          const right = style ? Number.parseFloat(style.paddingRight) : 16;
          const revision = nextLayout + 1;
          const next = nativeWorkspaceFrameFromAnchors({
            seat: seatBounds,
            shell: shellBounds,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            shellInsets: { left, right },
            bottomContentInset: Number.parseFloat(getComputedStyle(seat).paddingBottom),
            layoutRevision: revision,
          });
          if (!next) { void fail("NATIVE_WORKSPACE_FRAME_INVALID"); return; }
          if (frame && (frame.bottomContentInset ?? 0) === (next.bottomContentInset ?? 0) &&
              Object.entries(next).every(([key, value]) => key === "layoutRevision" || frame![key as keyof typeof next] === value)) return;
          nextLayout = revision; frame = next; emit();
        };
        observer = new ResizeObserver(measure); observer.observe(seat);
        if (contentFrame?.current) observer.observe(contentFrame.current);
        measure();
      } catch (error) { if (isCurrent()) await fail(error); }
    })().finally(() => { if (!active) { void handle?.remove(); void editHandle?.remove(); void isolationHandle?.remove(); observer?.disconnect(); void retire().then(retired => { if (retired || !finalOwnerCurrent()) releaseFinal(); }); } });
    return () => { void revoke(); };
  }, [owner, content.workspace, vaultEpoch, privacy?.generation, privacy?.appIsActive, privacy?.shielded, contentFrame, editorKind, presentationOwner, routeActive, admissionRevision, activationRevision]);
  // The native isolation owner already disables this retained body locally.
  // A matching update readmits current actions after the drawer disappears.
  useLayoutEffect(() => { publish.current(); }, [isolation, webCovered]);
  return phase;
}
