"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { captureNativeDrawerOwner, nativeDrawerOwnerIsCurrent } from "./native-drawer-owner";
import { nativeDrawers, nativeDrawerAcknowledged, subscribeNativeDrawerIsolation, nativeDrawerIsolation, observeNativeDrawerIsolation } from "./native-drawers";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "./session-privacy";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "../vault/session-epoch";
import { useNativeControlAppearance } from "./native-control-appearance";
import { sameNativeWorkspace, validNativeWorkspace, validWorkspaceCircleDraft, workspaceAcknowledged, type NativeWorkspaceIdentity, type NativeWorkspaceFrame, type NativeWorkspaceProjection, type NativeWorkspaceChoice, type NativeWorkspacePort, type NativeWorkspaceCircleDraft, type NativeWorkspaceEdit, type NativeWorkspaceFinalEdit } from "./native-workspace";
import type { PrivateProfileEditorModel } from "./native-profile-private-editor";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "./native-navigation";

export type NativeWorkspaceContent = Pick<NativeWorkspaceProjection, "workspace" | "page" | "title" | "enabled" | "backEnabled" | "sections" | "tabs" | "search">;
type CircleEditor = PrivateProfileEditorModel<NativeWorkspaceCircleDraft> & { destinationId: string; onSaved: () => void; onCancel: () => void };
let nextRevision = 0, nextLayout = 0;

/** One route body admission. No feature readers, writers, router or per-frame
 * synchronization live here. Uncertain retirement never exposes a duplicate. */
export function useNativeWorkspace({ owner, content, actions, back, current, editor, onRetirementOwner, contentFrame }: {
  owner: string; content: NativeWorkspaceContent; actions: ReadonlyMap<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>;
  back: () => void; current: () => boolean;
  editor?: CircleEditor;
  onRetirementOwner?: (revoke: () => Promise<boolean>) => void;
  contentFrame?: RefObject<HTMLElement | null>;
}) {
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const vaultEpoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const isolation = useSyncExternalStore(observeNativeDrawerIsolation, nativeDrawerIsolation, nativeDrawerIsolation);
  const webCovered = useNativeShellOverlayBlocked();
  const [phase, setPhase] = useState<"checking" | "native" | "web" | "blocked">(() => customNativePresentationEnabled() ? "checking" : "web");
  const [, setAcknowledgement] = useState(0);
  const live = useRef({ owner, content, actions, back, current, appearance, privacy, editor, onRetirementOwner });
  useLayoutEffect(() => { live.current = { owner, content, actions, back, current, appearance, privacy, editor, onRetirementOwner }; });
  const publish = useRef<() => void>(() => {});
  useLayoutEffect(() => { publish.current(); });
  useEffect(() => {
    if (!customNativePresentationEnabled()) return;
    const base = captureNativeDrawerOwner();
    if (!base || !privacy?.appIsActive || privacy.shielded) return;
    const identity: NativeWorkspaceIdentity = { ...base, revision: ++nextRevision, workspace: content.workspace };
    const generation = privacy.generation;
    let active = true, started = false, retired = false, withdrawing = false, running = false, sequence = 0, consumed = 0;
    let withdrawal: Promise<boolean> | undefined;
    let handle: PluginListenerHandle | undefined, isolationHandle: PluginListenerHandle | undefined, editHandle: PluginListenerHandle | undefined, finalHandle: PluginListenerHandle | undefined;
    let observer: ResizeObserver | undefined, frame: NativeWorkspaceFrame | undefined;
    let applied: NativeWorkspaceProjection | undefined, desired: NativeWorkspaceProjection | undefined, fingerprint = "";
    let port: NativeWorkspacePort | undefined;
    const edits = new Map<string, { revision: number; modelRevision: number; composing: boolean; discarded: boolean; model: CircleEditor }>();
    const issuedDrafts = new Map<number, { destinationId: string; revision: number }>();
    let acceptFinal = true;
    const releaseFinal = () => { if (!acceptFinal) return; acceptFinal = false; void finalHandle?.remove().catch(() => undefined); edits.clear(); stopEpoch(); stopPrivacy(); window.removeEventListener("pagehide", releaseFinal); };
    const finalOwnerCurrent = () => live.current.owner === owner && nativeDrawerOwnerIsCurrent(base) && snapshotVaultSessionEpoch() === vaultEpoch;
    const checkFinalOwner = () => { if (!finalOwnerCurrent()) releaseFinal(); };
    const stopEpoch = subscribeVaultSessionEpoch(checkFinalOwner), stopPrivacy = subscribeNativePrivacyObservation(checkFinalOwner);
    window.addEventListener("pagehide", releaseFinal);
    const isCurrent = () => active && !withdrawing && !retired && live.current.owner === owner && live.current.current() && nativeDrawerOwnerIsCurrent(base) &&
      snapshotVaultSessionEpoch() === vaultEpoch && live.current.privacy?.generation === generation && live.current.privacy.appIsActive && !live.current.privacy.shielded;
    const retireOnce = async () => {
      if (retired) return true;
      if (!started || !port) { retired = true; return true; }
      try {
        const receipt = await nativeDrawerAcknowledged(port.retireWorkspace(identity));
        retired = sameNativeWorkspace(receipt, identity) && receipt.phase === "retired" && receipt.settled;
      } catch {
        // Targeted readback diagnoses an uncertain outcome; never replay apply
        // or a business operation because a bridge response timed out.
        try {
          const state = await nativeDrawerAcknowledged(port.getWorkspaceState(identity));
          retired = "phase" in state && sameNativeWorkspace(state, identity) && state.phase === "retired" && state.settled;
        } catch { retired = false; }
      }
      return retired;
    };
    const retire = () => {
      withdrawing = true; desired = undefined; applied = undefined; fingerprint = "";
      withdrawal ??= retireOnce(); return withdrawal;
    };
    const fail = async () => { const absent = await retire(); if (active) setPhase(absent ? "web" : "blocked"); };
    const flush = async () => {
      if (running || !port || !desired || !isCurrent()) return;
      running = true;
      try {
        while (desired && desired !== applied && isCurrent()) {
          const state = desired;
          if (!validNativeWorkspace(state)) throw new Error("NATIVE_WORKSPACE_INVALID");
          started = true;
          const receipt = await nativeDrawerAcknowledged(port.applyWorkspace(state));
          if (!workspaceAcknowledged(receipt, state, "active")) throw new Error("NATIVE_WORKSPACE_UNCONFIRMED");
          applied = state;
          if (isCurrent()) setPhase("native");
        }
      } catch { if (isCurrent()) await fail(); }
      finally { running = false; }
    };
    const emit = () => {
      const value = live.current;
      if (!isCurrent() || !value.appearance || !frame || retired) return;
      // An unconverted DOM modal is a whole-family incompatibility, not a
      // request to hide/recreate individual controls. Withdraw this body and
      // confirm absence before admitting the established web presentation.
      if (nativeShellOverlayBlocked()) { void fail(); return; }
      let circleEditor: NativeWorkspaceProjection["circleEditor"];
      if (value.editor?.current()) {
        const editor = value.editor;
        let accepted = edits.get(editor.destinationId);
        if (!accepted) { accepted = { revision: 0, modelRevision: editor.inputRevision(), composing: false, discarded: false, model: editor }; edits.set(editor.destinationId, accepted); }
        accepted.model = editor;
        circleEditor = { destinationId: editor.destinationId, draft: { ...editor.draft }, draftRevision: editor.inputRevision(), acknowledgedEditRevision: accepted.revision,
          canSave: editor.canSave && !accepted.composing, busy: editor.busy, error: editor.error };
      }
      const next = { ...identity, ...value.appearance, ...value.content, frame, privacyGeneration: generation, isolationGeneration: nativeDrawerIsolation().generation,
        ...(circleEditor ? { circleEditor } : {}) };
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
        !validWorkspaceCircleDraft(event.draft) || !nativeDrawerOwnerIsCurrent(base) || snapshotVaultSessionEpoch() !== vaultEpoch) return;
      const accepted = edits.get(event.destinationId);
      if (!accepted || accepted.discarded || !accepted.model.current() || event.editRevision <= accepted.revision) return;
      if (!final && (!isCurrent() || live.current.editor?.destinationId !== event.destinationId)) return;
      const revision = accepted.model.inputRevision();
      if (!final) {
        const issued = issuedDrafts.get(event.updateSequence);
        if (!issued || issued.destinationId !== event.destinationId || revision !== issued.revision && revision !== accepted.modelRevision) { void fail(); return; }
      }
      if (final && (!("baseDraftRevision" in event) || event.composing || !Number.isSafeInteger(event.baseDraftRevision) ||
        revision !== event.baseDraftRevision && revision !== accepted.modelRevision)) return;
      if (!accepted.model.changeDraft(event.draft, revision)) return;
      accepted.revision = event.editRevision; accepted.modelRevision = accepted.model.inputRevision(); accepted.composing = event.composing;
      // Composition-only changes need an explicit acknowledgement too. Keep
      // the model's current draft in the replica until React's next commit.
      if (active) setAcknowledgement(value => value + 1);
      if (final) { edits.delete(event.destinationId); if (!active && !edits.size) releaseFinal(); }
    };
    const choose = async (choice: NativeWorkspaceChoice) => {
      if (!port || !applied || !isCurrent() || !sameNativeWorkspace(choice, identity) || choice.privacyGeneration !== generation ||
        !Number.isSafeInteger(choice.sequence) || choice.sequence <= consumed) return;
      consumed = choice.sequence;
      const state = applied;
      const isolationGeneration = nativeDrawerIsolation().generation;
      try {
        const admission = await nativeDrawerAcknowledged(port.confirmWorkspaceChoice(choice));
        if (admission.valid && isCurrent() && applied === state && desired === state && state.updateSequence === choice.updateSequence &&
          nativeDrawerIsolation().generation === isolationGeneration && !nativeDrawerIsolation().isolated && !nativeShellOverlayBlocked()) {
          if (choice.action === "circle-save" || choice.action === "circle-cancel") {
            const editor = live.current.editor, accepted = editor && edits.get(editor.destinationId);
            if (!editor?.current() || !accepted || accepted.composing || accepted.revision !== choice.editRevision || editor.mutationPending()) return;
            if (choice.action === "circle-cancel") { accepted.discarded = true; editor.onCancel(); }
            else if (editor.canSave && await editor.save() && isCurrent() && live.current.editor?.destinationId === editor.destinationId) {
              accepted.discarded = true; live.current.editor.onSaved();
            }
          } else {
            const callback = choice.action === "back" && state.backEnabled ? () => live.current.back() : choice.action === "row" && choice.rowId ? live.current.actions.get(choice.rowId) : undefined;
            await callback?.(choice);
          }
        }
      } finally { await nativeDrawerAcknowledged(port.settleWorkspaceChoice(choice)).catch(() => undefined); }
    };
    void (async () => {
      try {
        const capabilities = await nativeDrawerAcknowledged(nativeDrawers.getCapabilities());
        if (!isCurrent()) return;
        if (capabilities.contractVersion !== 1 || !capabilities.supported || !capabilities.routeWorkspaces?.includes(content.workspace) ||
          !nativeDrawers.applyWorkspace || !nativeDrawers.retireWorkspace || !nativeDrawers.confirmWorkspaceChoice || !nativeDrawers.settleWorkspaceChoice || !nativeDrawers.getWorkspaceState) { setPhase("web"); return; }
        port = { applyWorkspace: nativeDrawers.applyWorkspace.bind(nativeDrawers), retireWorkspace: nativeDrawers.retireWorkspace.bind(nativeDrawers),
          confirmWorkspaceChoice: nativeDrawers.confirmWorkspaceChoice.bind(nativeDrawers), settleWorkspaceChoice: nativeDrawers.settleWorkspaceChoice.bind(nativeDrawers), getWorkspaceState: nativeDrawers.getWorkspaceState.bind(nativeDrawers) };
        handle = await nativeDrawers.addListener("workspaceChoice", value => { void choose(value).catch(() => undefined); });
        editHandle = await nativeDrawers.addListener("workspaceEdit", value => acceptEdit(value, false));
        finalHandle = await nativeDrawers.addListener("workspaceFinalEdit", value => acceptEdit(value, true));
        if (!acceptFinal) void finalHandle.remove().catch(() => undefined);
        isolationHandle = await subscribeNativeDrawerIsolation(nativeDrawers);
        if (!isCurrent()) return;
        const seat = document.querySelector<HTMLElement>('[data-native-workspace-seat="true"]');
        if (!seat) throw new Error("NATIVE_WORKSPACE_SEAT_MISSING");
        const measure = () => {
          const rect = seat.getBoundingClientRect();
          const authored = contentFrame?.current;
          const bounds = authored?.getBoundingClientRect() ?? rect;
          const inset = authored ? Number.parseFloat(getComputedStyle(authored).paddingLeft) : 16;
          const next = { x: bounds.x, y: rect.y, width: bounds.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
            contentInset: Number.isFinite(inset) ? inset : 16 };
          if (frame && Object.entries(next).every(([key, value]) => frame![key as keyof typeof next] === value)) return;
          frame = { ...next, layoutRevision: ++nextLayout }; emit();
        };
        observer = new ResizeObserver(measure); observer.observe(seat);
        if (contentFrame?.current) observer.observe(contentFrame.current);
        measure();
      } catch { if (isCurrent()) await fail(); }
    })().finally(() => { if (!active) { void handle?.remove(); void editHandle?.remove(); void isolationHandle?.remove(); observer?.disconnect(); void retire().then(retired => { if (retired || !finalOwnerCurrent()) releaseFinal(); }); } });
    const revoke = async () => {
      active = false; publish.current = () => {}; desired = undefined; fingerprint = "";
      observer?.disconnect(); void handle?.remove(); void editHandle?.remove(); void isolationHandle?.remove();
      const absent = await retire(); if (absent || !finalOwnerCurrent()) releaseFinal(); return absent;
    };
    live.current.onRetirementOwner?.(revoke);
    return () => { void revoke(); };
  }, [owner, content.workspace, vaultEpoch, privacy?.generation, privacy?.appIsActive, privacy?.shielded, contentFrame]);
  // The native isolation owner already disables this retained body locally.
  // A matching update readmits current actions after the drawer disappears.
  useLayoutEffect(() => { publish.current(); }, [isolation, webCovered]);
  return phase;
}
