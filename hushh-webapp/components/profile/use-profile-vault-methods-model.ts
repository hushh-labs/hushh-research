"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { VaultMethodService, type VaultCapabilityMatrix } from "@/lib/services/vault-method-service";
import { VaultBootstrapService } from "@/lib/services/vault-bootstrap-service";
import { VaultService, type VaultMethod, type VaultWrapper } from "@/lib/services/vault-service";

type Ports = {
  userId: string | null; vaultKey: string | null; vaultOwnerToken: string | null;
  hasVault: boolean | null; authLoading: boolean; canMutate: boolean; active: boolean;
  displayName: string; requestUnlock: () => void;
};
type MethodState = {
  owner: string | null; primaryMethod: VaultMethod | null; primaryWrapperId: string | null;
  effectiveMethod: VaultMethod | null; wrappers: VaultWrapper[];
  capability: VaultCapabilityMatrix | null; localBiometricId: string | null;
  loading: boolean; needsRefresh: boolean;
};
const emptyState = (): MethodState => ({ owner: null, primaryMethod: null, primaryWrapperId: null,
  effectiveMethod: null, wrappers: [], capability: null, localBiometricId: null, loading: false, needsRefresh: false });
const sameMethod = (a: VaultWrapper, b: VaultWrapper) => a.method === b.method &&
  (a.wrapperId ?? "default") === (b.wrapperId ?? "default");

/** One volatile feature owner for both renderers. Secrets and wrapper material
 * remain here and in the existing Vault services, never in native row metadata. */
export function useProfileVaultMethodsModel(ports: Ports) {
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [state, setState] = useState<MethodState>(emptyState);
  const stateRef = useRef(state);
  const writeState = useCallback((update: MethodState | ((previous: MethodState) => MethodState)) => {
    const next = typeof update === "function" ? update(stateRef.current) : update;
    stateRef.current = next; setState(next);
  }, []);
  const current = useRef(ports); current.current = ports;
  const [busy, setBusy] = useState(false);
  const [passphraseOpen, setPassphraseOpen] = useState(false);
  const [removal, setRemoval] = useState<VaultWrapper | null>(null);
  const removalRef = useRef<VaultWrapper | null>(null);
  const removalRevision = useRef(0);
  const renderedRemovalRevision = removalRevision.current;
  const changeRemoval = useCallback((value: VaultWrapper | null) => {
    removalRevision.current++; removalRef.current = value; setRemoval(value);
  }, []);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const secret = useRef({ open: false, password: "", confirmation: "", revision: 0 });
  const renderedSecretRevision = secret.current.revision;
  const request = useRef(0);
  const invalidateReads = useCallback(() => { request.current += 1; }, []);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);
  const mounted = useRef(false);
  const pending = useRef<{ controller: AbortController; toastId: string | number | undefined; committed: boolean } | null>(null);
  const latestAttempt = useRef<symbol | null>(null);
  const surfaceVisit = useMemo(() => ({ active: false, userId: ports.userId, enabled: ports.active }), [ports.userId, ports.active]);
  const [outcome, setOutcome] = useState<{ visit: typeof surfaceVisit; text: string } | null>(null);
  const vaultEpoch = snapshotVaultSessionEpoch();
  const visit = useMemo(() => ({ active: false, owner: snapshotValidatedAuthSessionOwner(),
    userId: ports.userId, key: ports.vaultKey, epoch: vaultEpoch, enabled: ports.active && !ports.authLoading }),
  [ports.userId, ports.vaultKey, ports.active, ports.authLoading, vaultEpoch]);
  const ownerCurrent = useCallback(() => mounted.current && !!ports.userId &&
    current.current.userId === ports.userId && current.current.vaultKey === ports.vaultKey &&
    vaultEpoch === snapshotVaultSessionEpoch() && snapshotValidatedAuthSessionOwner()?.userId === ports.userId,
  [ports.userId, ports.vaultKey, vaultEpoch]);
  const visitCurrent = () => visit.active && visit.enabled && !!visit.owner && ownerCurrent() &&
    visit.owner.userId === ports.userId && isValidatedAuthSessionOwnerCurrent(visit.owner);
  useLayoutEffect(() => { surfaceVisit.active = true; return () => { surfaceVisit.active = false; }; }, [surfaceVisit]);
  const clearSecret = useCallback(() => {
    secret.current = { open: false, password: "", confirmation: "", revision: secret.current.revision + 1 };
    setPassphraseOpen(false); setPassword(""); setConfirmation("");
  }, []);
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false; invalidateReads(); pending.current?.controller.abort();
    if (pending.current?.toastId !== undefined && !pending.current.committed) toast.dismiss(pending.current.toastId);
    secret.current = { open: false, password: "", confirmation: "", revision: secret.current.revision + 1 };
  }; }, [invalidateReads]);
  useLayoutEffect(() => {
    visit.active = true;
    return () => {
      visit.active = false; invalidateReads(); pending.current?.controller.abort();
      if (pending.current?.toastId !== undefined && !pending.current.committed) toast.dismiss(pending.current.toastId);
      secret.current = { open: false, password: "", confirmation: "", revision: secret.current.revision + 1 };
    };
  }, [visit, invalidateReads]);
  useLayoutEffect(() => { clearSecret(); changeRemoval(null); }, [visit, ports.canMutate, clearSecret, changeRemoval]);
  useLayoutEffect(() => {
    if (privacy?.shielded || privacy?.appIsActive === false) { clearSecret(); changeRemoval(null); }
  }, [privacy?.generation, privacy?.shielded, privacy?.appIsActive, clearSecret, changeRemoval]);

  const refresh = useCallback(async () => {
    const owner = current.current.userId;
    if (!owner || current.current.hasVault !== true || pending.current || !ownerCurrent()) return false;
    const ordinal = ++request.current;
    const valid = () => ownerCurrent() && current.current.userId === owner && request.current === ordinal && !pending.current;
    const forceFresh = stateRef.current.needsRefresh;
    if (forceFresh) VaultService.invalidateVaultStateCache(owner);
    writeState(previous => ({ ...(previous.owner === owner ? previous : emptyState()), owner, loading: true }));
    try {
      const [capability, vault, localBiometricId] = await Promise.all([
        VaultMethodService.getCapabilityMatrix(), VaultService.getVaultState(owner, { forceFresh }),
        VaultBootstrapService.getDeviceBiometricWrapperId(owner),
      ]);
      if (!valid()) return false;
      const recommended = capability.recommendedMethod !== "passphrase" ? capability.recommendedMethod : null;
      const quick = recommended ? VaultService.getWrapperByMethod(vault, recommended,
        recommended === "generated_default_native_biometric" ? { wrapperId: localBiometricId } : undefined) : null;
      const prefersQuick = vault.primaryMethod !== "passphrase";
      writeState({ owner, primaryMethod: vault.primaryMethod, primaryWrapperId: vault.primaryWrapperId ?? "default",
        effectiveMethod: prefersQuick ? quick?.method ?? "passphrase" : VaultService.getPrimaryWrapper(vault).method,
        wrappers: vault.wrappers, capability, localBiometricId, loading: false, needsRefresh: false });
      return true;
    } catch {
      if (valid()) { writeState(previous => ({ ...previous, needsRefresh: true })); console.warn("VAULT_METHOD_REFRESH_FAILED"); }
      return false;
    } finally { if (valid()) writeState(previous => ({ ...previous, loading: false })); }
  }, [ownerCurrent, writeState]);
  refreshRef.current = refresh;
  useEffect(() => {
    if (ports.authLoading) return;
    if (!ports.userId || ports.hasVault !== true) { request.current++; writeState(emptyState()); return; }
    void refresh();
    return invalidateReads;
  }, [ports.authLoading, ports.userId, ports.hasVault, ports.active, refresh, writeState, invalidateReads]);

  function mutable() {
    const livePrivacy = nativePrivacyObservation().state;
    if (livePrivacy?.shielded || livePrivacy?.appIsActive === false) return false;
    if (!visitCurrent() || pending.current || stateRef.current.owner !== ports.userId ||
        stateRef.current.needsRefresh || stateRef.current.loading) return false;
    if (current.current.canMutate && current.current.vaultKey && current.current.vaultOwnerToken) return true;
    toast.info("Unlock your vault to change methods."); current.current.requestUnlock(); return false;
  }
  async function run(operation: (valid: () => boolean, signal: AbortSignal, committed: () => void) => Promise<boolean>, success: string, failure: string) {
    if (!mutable()) return;
    setOutcome(null);
    const intent = Symbol("vault-method-change"); latestAttempt.current = intent;
    const attempt = { controller: new AbortController(), toastId: undefined as string | number | undefined, committed: false };
    pending.current = attempt; request.current++; setBusy(true);
    const valid = () => pending.current === attempt && visitCurrent();
    let resolveFeedback!: (value: boolean) => void;
    let rejectFeedback!: (error: Error) => void;
    const feedback = new Promise<boolean>((resolve, reject) => { resolveFeedback = resolve; rejectFeedback = reject; });
    void feedback.catch(() => undefined);
    let commitWasCurrent = false, suppressed = false;
    const handle = toast.promise(feedback, { loading: "Updating unlock methods…", success, error: failure,
      isCurrent: () => !suppressed && latestAttempt.current === intent && (visitCurrent() || attempt.committed && commitWasCurrent &&
        surfaceVisit.active && surfaceVisit.enabled && surfaceVisit.userId === current.current.userId && current.current.active &&
        !!visit.owner && isValidatedAuthSessionOwnerCurrent(visit.owner)) });
    if (typeof handle === "string" || typeof handle === "number") attempt.toastId = handle;
    const requireReconciliation = () => {
      // Invalidate even if the caller's key epoch changed while the write was
      // in flight. This is cache cleanup, not permission to publish old state.
      VaultService.invalidateVaultStateCache(ports.userId!);
      if (mounted.current && current.current.userId === ports.userId) {
        writeState(previous => ({ ...previous, needsRefresh: true }));
      }
    };
    const committed = () => {
      if (attempt.committed) return;
      commitWasCurrent = valid();
      attempt.committed = true;
      if (commitWasCurrent) setOutcome({ visit: surfaceVisit, text: success });
      resolveFeedback(true);
    };
    try {
      if (!await operation(valid, attempt.controller.signal, committed)) {
        suppressed = true; resolveFeedback(false);
        if (attempt.toastId !== undefined) toast.dismiss(attempt.toastId);
        return;
      }
      committed();
      requireReconciliation();
    } catch {
      // A timed-out/aborted write is not a rollback. A fresh read is required
      // before another change; never repeat an uncertain mutation automatically.
      requireReconciliation();
      if (attempt.committed) resolveFeedback(true);
      else {
        if (valid()) setOutcome({ visit: surfaceVisit, text: "We couldn't confirm the change. Refresh your methods before trying again." });
        rejectFeedback(new Error("VAULT_METHOD_CHANGE_FAILED"));
      }
      console.warn(attempt.committed ? "VAULT_METHOD_POST_COMMIT_FAILED" : "VAULT_METHOD_CHANGE_FAILED");
    } finally {
      if (pending.current === attempt) {
        pending.current = null;
        if (mounted.current) setBusy(false);
        if (mounted.current && current.current.active) void refreshRef.current();
      }
      if (!visitCurrent() && !attempt.committed && attempt.toastId !== undefined) toast.dismiss(attempt.toastId);
    }
  }
  async function add(targetMethod: VaultMethod) {
    if (targetMethod !== stateRef.current.capability?.recommendedMethod || targetMethod === "passphrase") return;
    await run(async (valid, signal) => {
      if (!valid()) return false;
      await VaultMethodService.switchMethod({ userId: ports.userId!, currentVaultKey: ports.vaultKey!,
        displayName: ports.displayName, targetMethod, signal });
      return true;
    }, "Unlock method added.", "We couldn't add this unlock method. Your existing methods still work.");
  }
  async function select(wrapper: VaultWrapper) {
    if (!stateRef.current.wrappers.some(candidate => sameMethod(candidate, wrapper))) return;
    await run(async valid => {
      if (!valid()) return false;
      await VaultService.setPrimaryVaultMethod(ports.userId!, wrapper.method, wrapper.wrapperId ?? "default", ports.vaultOwnerToken!);
      if (valid()) writeState(previous => ({ ...previous, primaryMethod: wrapper.method,
        primaryWrapperId: wrapper.wrapperId ?? "default", effectiveMethod: wrapper.method === "generated_default_native_biometric" &&
          (wrapper.wrapperId ?? "default") !== previous.localBiometricId ? "passphrase" : wrapper.method }));
      return true;
    }, "Default unlock updated.", "We couldn't change your default unlock.");
  }
  function requestRemove(wrapper: VaultWrapper) {
    if (!mutable() || wrapper.method === "passphrase" || wrapper.method === "generated_default_native_biometric" ||
      !stateRef.current.wrappers.some(candidate => sameMethod(candidate, wrapper))) return;
    changeRemoval(wrapper);
  }
  async function remove() {
    const target = removalRef.current;
    if (!target || target !== removal || removalRevision.current !== renderedRemovalRevision ||
        !stateRef.current.wrappers.some(candidate => sameMethod(candidate, target))) return;
    await run(async valid => {
      if (!valid()) return false;
      const result = await VaultMethodService.removeMethod({ userId: ports.userId!, currentVaultKey: ports.vaultKey!,
        vaultOwnerToken: ports.vaultOwnerToken!, method: target.method, wrapperId: target.wrapperId ?? "default",
        fallbackPrimaryMethod: "passphrase", fallbackPrimaryWrapperId: "default" });
      if (valid()) {
        writeState(previous => ({ ...previous, primaryMethod: result.primaryMethod,
          ...(previous.primaryMethod === target.method && (previous.primaryWrapperId ?? "default") === (target.wrapperId ?? "default")
            ? { primaryWrapperId: "default", effectiveMethod: "passphrase" as const } : {}),
          wrappers: previous.wrappers.filter(candidate => !sameMethod(candidate, target)) }));
        changeRemoval(null);
      }
      return true;
    }, "Passkey removed. Passphrase is still available.", "We couldn't remove this passkey.");
  }
  function openPassword() { if (mutable()) { clearSecret(); secret.current.open = true; setPassphraseOpen(true); } }
  function editPassword(kind: "password" | "confirmation", value: string) {
    const livePrivacy = nativePrivacyObservation().state;
    if (livePrivacy?.shielded || livePrivacy?.appIsActive === false || !visitCurrent() || !secret.current.open || pending.current) return;
    secret.current = { ...secret.current, [kind]: value, revision: secret.current.revision + 1 };
    if (kind === "password") setPassword(value); else setConfirmation(value);
  }
  function closePassword() { if (!pending.current) clearSecret(); }
  async function savePassword() {
    const draft = secret.current;
    if (!draft.open || draft.revision !== renderedSecretRevision || draft.password.length < 8 || draft.password !== draft.confirmation) return;
    await run(async (valid, signal, committed) => {
      if (!valid() || secret.current.revision !== draft.revision) return false;
      try {
        await VaultMethodService.changePassphrase({ userId: ports.userId!, currentVaultKey: ports.vaultKey!,
          newPassphrase: draft.password, keepPrimaryMethod: true, signal, onCommitted: result => {
            committed();
            if (!valid()) return;
            writeState(previous => ({ ...previous, primaryMethod: result.primaryMethod })); clearSecret();
          } });
        return true;
      } finally {
        // The provider owns any in-flight value; the editor retains no secret
        // after submission, including a refused or uncertain result.
        if (visitCurrent()) clearSecret();
      }
    }, "Passphrase updated.", "We couldn't change your passphrase.");
  }
  return { ...(state.owner === ports.userId ? state : emptyState()), busy, refresh, add, select, removal, requestRemove, remove,
    notice: outcome?.visit === surfaceVisit && ports.active && !privacy?.shielded && privacy?.appIsActive !== false ? outcome.text : null,
    cancelRemove: () => { if (!pending.current) changeRemoval(null); },
    passphraseOpen, password, confirmation, openPassword, closePassword,
    editPassword, savePassword };
}
