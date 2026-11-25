"use client";

import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { NativeVaultGateFence, nativeVaultGate, sameNativeVaultGate, validNativeVaultGateProjection, validNativeVaultGateReceipt, type NativeVaultGateAction, type NativeVaultGateEdit, type NativeVaultGateIdentity, type NativeVaultGateProjection } from "@/lib/capacitor/native-vault-gate";
import { readNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import {
  getNativeSessionPrivacyState,
  nativeDocumentId,
  nativePrivacyCanInteract,
  subscribeNativeSessionPrivacy,
} from "@/lib/capacitor/session-privacy";

export type NativeVaultGateFields = Omit<NativeVaultGateProjection,
  keyof NativeVaultGateIdentity | "updateSequence" | "privacyGeneration" | "acknowledgedEditRevision" |
  "appearance" | "accentHex" | "foregroundHex">;

type Props = {
  fields: NativeVaultGateFields;
  ownerIsCurrent: () => boolean;
  onEdit: (event: NativeVaultGateEdit) => void;
  onAction: (event: NativeVaultGateAction) => void | Promise<void>;
  onInterrupted: () => void;
  onPhase?: (phase: "preparing" | "active" | "fallback") => void;
};

/** Owns only the transient native full-screen presentation. All state changes
 * are returned to VaultFlow, which remains the owner of every Vault operation. */
export function NativeVaultGate({ fields, ownerIsCurrent, onEdit, onAction, onInterrupted, onPhase }: Props) {
  const fieldsRef = useRef(fields);
  const publishRef = useRef<(next: NativeVaultGateFields) => void>(() => undefined);
  const callbacksRef = useRef({ ownerIsCurrent, onEdit, onAction, onInterrupted, onPhase });
  fieldsRef.current = fields;
  callbacksRef.current = { ownerIsCurrent, onEdit, onAction, onInterrupted, onPhase };

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios" || typeof window === "undefined") return;
    let mounted = true;
    let started = false;
    let stopped = false;
    let publishing = false;
    let nextFields: NativeVaultGateFields | null = fieldsRef.current;
    let highestUpdate = 0;
    let seenAction = 0;
    let latest: NativeVaultGateProjection | null = null;
    let privacyGeneration: number | null = null;
    let privacyListener: { remove: () => Promise<void> } | null = null;
    let eventHandles: Array<{ remove: () => Promise<void> }> = [];
    let plugin: ReturnType<typeof nativeVaultGate> | null = null;
    let identity: NativeVaultGateIdentity | null = null;
    let fence: NativeVaultGateFence | null = null;
    let retirement: Promise<void> | null = null;

    const report = (phase: "preparing" | "active" | "fallback") => {
      if (mounted) callbacksRef.current.onPhase?.(phase);
    };
    const scrubPrivateReferences = () => {
      const currentFields = fieldsRef.current;
      fieldsRef.current = { ...currentFields, password: "", confirmation: "", recoveryKeyInput: "", recoveryKey: "" };
      if (latest) latest = { ...latest, password: "", confirmation: "", recoveryKeyInput: "", recoveryKey: "" };
    };
    const clearByInterruption = () => {
      if (stopped) return;
      stopped = true;
      nextFields = null;
      fence?.retire();
      scrubPrivateReferences();
      callbacksRef.current.onInterrupted();
      report("fallback");
      void retire();
    };
    const sameIdentity = (value: NativeVaultGateIdentity) => !!identity && sameNativeVaultGate(value, identity);

    const makeProjection = (next: NativeVaultGateFields): NativeVaultGateProjection | null => {
      if (!identity || privacyGeneration === null) return null;
      const appearance = readNativeControlAppearance("accent");
      if (!appearance) return null;
      const projection: NativeVaultGateProjection = {
        ...identity,
        ...appearance,
        ...next,
        updateSequence: ++highestUpdate,
        privacyGeneration,
        acknowledgedEditRevision: latest?.acknowledgedEditRevision ?? 0,
      };
      if (!validNativeVaultGateProjection(projection)) return null;
      return projection;
    };

    const publish = (next: NativeVaultGateFields) => {
      if (stopped || !started || !plugin || !identity) return;
      nextFields = next;
      if (publishing) return;
      publishing = true;
      void (async () => {
        try {
          while (nextFields && !stopped && mounted) {
            const fieldsToApply = nextFields;
            nextFields = null;
            const projection = makeProjection(fieldsToApply);
            if (!projection) throw new Error("NATIVE_VAULT_GATE_INVALID_PROJECTION");
            const receipt = await plugin!.applyVaultGateScene(projection);
            if (stopped || !mounted) return;
            if (!validNativeVaultGateReceipt(receipt, identity!, projection.updateSequence,
              projection.privacyGeneration, "active") || !callbacksRef.current.ownerIsCurrent()) {
              throw new Error("NATIVE_VAULT_GATE_UNCERTAIN_ACK");
            }
            latest = projection;
            report("active");
          }
        } catch {
          clearByInterruption();
        } finally {
          publishing = false;
          if (nextFields && !stopped && mounted) publish(nextFields);
        }
      })();
    };
    publishRef.current = publish;

    const handleEdit = (event: NativeVaultGateEdit) => {
      const current = latest;
      if (stopped || !current || !fence || !sameIdentity(event) || !fence.consumeEdit(event, current) ||
          !callbacksRef.current.ownerIsCurrent()) return;
      latest = { ...current, acknowledgedEditRevision: event.editRevision };
      callbacksRef.current.onEdit(event);
    };

    const handleAction = async (event: NativeVaultGateAction) => {
      const current = latest;
      const activePlugin = plugin;
      if (stopped || !current || !fence || !activePlugin || !sameIdentity(event) ||
          event.sequence <= seenAction || event.updateSequence !== current.updateSequence ||
          event.privacyGeneration !== current.privacyGeneration || event.editRevision !== current.acknowledgedEditRevision ||
          !callbacksRef.current.ownerIsCurrent()) return;
      seenAction = event.sequence;
      if (!fence.consumeAction(event, current)) return;
      let confirmed = false;
      try {
        confirmed = (await activePlugin.confirmVaultGateAction(event)).valid;
        if (!confirmed || stopped || !callbacksRef.current.ownerIsCurrent()) return;
        if (event.action === "delete_lost_vault" || event.action === "sign_out") {
          await retire();
          if (!mounted) return;
        }
        await callbacksRef.current.onAction(event);
      } catch {
        clearByInterruption();
      } finally {
        if (confirmed && !stopped && mounted) {
          try {
            const settled = await activePlugin.settleVaultGateAction(event);
            if (!settled.valid) clearByInterruption();
          } catch { clearByInterruption(); }
        }
      }
    };

    const retire = (): Promise<void> => retirement ??= (async () => {
      stopped = true;
      started = false;
      nextFields = null;
      fence?.retire();
      scrubPrivateReferences();
      const activePlugin = plugin;
      const activeIdentity = identity;
      if (activePlugin && activeIdentity) {
        try {
          const finalSequence = highestUpdate;
          const finalPrivacyGeneration = privacyGeneration ?? 0;
          const receipt = await activePlugin.retireVaultGateScene({ ...activeIdentity,
            updateSequence: finalSequence, privacyGeneration: finalPrivacyGeneration });
          if (!validNativeVaultGateReceipt(receipt, activeIdentity, finalSequence,
            finalPrivacyGeneration, "retired")) {
            // The native view still fails closed. An uncertain receipt never
            // causes a credential operation or a retry of the presentation.
          }
        } catch { /* Retirement is best-effort after native scrub; React stays the fallback. */ }
      }
      for (const handle of eventHandles) void handle.remove().catch(() => undefined);
      eventHandles = [];
      if (privacyListener) void privacyListener.remove().catch(() => undefined);
      privacyListener = null;
    })();

    const initialize = async () => {
      report("preparing");
      try {
        plugin = nativeVaultGate();
        const capability = await plugin.getCapabilities();
        if (!mounted || !capability.available || !callbacksRef.current.ownerIsCurrent()) {
          report("fallback"); return;
        }
        const doc = nativeDocumentId();
        const privacy = await getNativeSessionPrivacyState();
        if (!mounted || !nativePrivacyCanInteract(privacy)) { report("fallback"); return; }
        identity = {
          documentId: doc,
          ownerEpoch: crypto.randomUUID(),
          ownerGeneration: 1,
          revision: Date.now(),
          scene: "vault-hard-gate",
          destinationId: crypto.randomUUID(),
        };
        privacyGeneration = privacy.generation;
        fence = new NativeVaultGateFence(identity);
        const editHandle = await plugin.addListener("vaultGateEdit", handleEdit);
        eventHandles.push(editHandle);
        const actionHandle = await plugin.addListener("vaultGateAction", event => { void handleAction(event); });
        eventHandles.push(actionHandle);
        const retiredHandle = await plugin.addListener("vaultGateRetired", event => {
          if (identity && sameIdentity(event)) clearByInterruption();
        });
        eventHandles.push(retiredHandle);
        privacyListener = await subscribeNativeSessionPrivacy(state => {
          if (!nativePrivacyCanInteract(state) || state.generation !== privacyGeneration) clearByInterruption();
        });
        if (!mounted || stopped) return;
        started = true;
        publish(fieldsRef.current);
      } catch {
        report("fallback");
        await retire();
      }
    };

    void initialize();
    return () => {
      mounted = false;
      publishRef.current = () => undefined;
      // This effect belongs to the owner captured at mount. If the owner has
      // rotated, clear VaultFlow's credential drafts before another owner can
      // inherit the still-mounted parent state. Same-owner renderer fallback
      // keeps the React draft intact.
      if (!ownerIsCurrent()) onInterrupted();
      void retire();
    };
    // The presentation is created once for a VaultFlow lifetime. React updates
    // the private projection through the effect below without replacing owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    publishRef.current(fields);
  }, [fields]);

  return null;
}
