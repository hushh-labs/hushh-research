"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { useSecretReveal } from "./use-secret-reveal";
import { SECRET_KIND_LABELS, useSecretValueControls, type SecretPanelItem } from "./secret-items-panel";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";
import { SecretsVaultService, type SecretItemSummary } from "@/lib/pkm/secrets-vault-service";
import { clearSecretOffer, peekSecretOffer, stageSecretOffer } from "@/lib/pkm/secret-offer-handoff";
import { secretOfferFor } from "@/lib/pkm/secret-span-guard";
import { identityDocumentTypeFor, KycIdentityDocumentsService } from "@/lib/services/kyc-identity-documents-service";

const FILED_LABELS = { wallet: "Filed in Wallet", kyc_identity_documents: "Filed in Identity documents" } as const;
export function secretPanelItem(item: SecretItemSummary): SecretPanelItem {
  return { id: item.id, label: item.label, kindLabel: SECRET_KIND_LABELS[item.kind] ?? "Secret", offer: secretOfferFor(item),
    filedLabel: item.filedTo ? FILED_LABELS[item.filedTo] : null };
}

/** One list/reveal/filing owner, shared by web and the private native scene.
 * Values stay in the existing reveal hook; no second decryptor or writer. */
export function useSecretsListModel({ active, native, current }: { active: boolean; native: boolean; current: () => boolean }) {
  const reveal = useSecretReveal(active);
  const { getVaultOwnerToken } = useVault();
  const { userId, vaultKey, vaultOwnerToken } = reveal.vaultContext;
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const generation = privacy?.generation;
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const allowed = active && !reveal.locked && document.visibilityState !== "hidden";
  const owner = useMemo(() => ({ live: false, pending: false, reads: 0, admitted: allowed, visibilityEpoch, id: crypto.randomUUID(), userId, key: vaultKey, epoch, generation,
    auth: snapshotValidatedAuthSessionOwner() }), [userId, vaultKey, epoch, generation, allowed, visibilityEpoch]);
  const live = useRef({ owner, current, allowed });
  useLayoutEffect(() => { live.current = { owner, current, allowed }; owner.live = allowed;
    return () => { owner.live = false; }; }, [owner, current, allowed]);
  const isCurrent = useCallback(() => {
    const privacy = nativePrivacyObservation().state;
    return owner.live && live.current.owner === owner && live.current.allowed && live.current.current() &&
      owner.auth?.userId === userId && isValidatedAuthSessionOwnerCurrent(owner.auth) && snapshotVaultSessionEpoch() === epoch &&
      !!getVaultOwnerToken() && document.visibilityState !== "hidden" && privacy?.generation === generation &&
      !privacy?.shielded && privacy?.appIsActive !== false && (!Capacitor.isNativePlatform() || !!privacy);
  }, [owner, userId, epoch, generation, getVaultOwnerToken]);
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; items: SecretItemSummary[]; loading: boolean; failed: boolean } | null>(null);
  const [selection, setSelection] = useState<{ owner: typeof owner; id: string | null; removing: string | null; uncertain: boolean; outcome: string | null } | null>(null);
  const [filing, setFiling] = useState<{ owner: typeof owner; item: SecretItemSummary; state: "idle" | "filing" | "filed" | "failed" } | null>(null);
  // Presentation-local settlement survives privacy/visit retirement for this
  // owner. No values or credentials; no automatic retry of an uncertain write.
  const attempts = useMemo(() => ({ ownerUserId: userId, states: new Map<string, "filing" | "filed" | "failed">() }), [userId]);
  const [, renderSettlement] = useState(0);
  const items = allowed && snapshot?.owner === owner ? snapshot.items : [];
  const local = selection?.owner === owner ? selection : null;
  const selected = items.find(item => item.id === local?.id) ?? null;
  const target = items.find(item => item.id === local?.removing) ?? null;
  const change = (patch: Partial<NonNullable<typeof selection>>) => {
    if (isCurrent()) setSelection(previous => ({ owner, id: null, removing: null, uncertain: false, outcome: null, ...(previous?.owner === owner ? previous : {}), ...patch }));
  };
  const refresh = useCallback(async () => {
    if (!isCurrent() || !vaultKey || !vaultOwnerToken) return;
    const request = ++owner.reads;
    setSnapshot(previous => ({ owner, items: previous?.owner === owner ? previous.items : [], loading: true, failed: false }));
    try {
      const next = await SecretsVaultService.listSecrets({ userId, vaultKey, vaultOwnerToken });
      if (!isCurrent() || request !== owner.reads) return;
      setSnapshot({ owner, items: next, loading: false, failed: false });
      setSelection(previous => previous?.owner === owner ? { ...previous, uncertain: false,
        removing: next.some(item => item.id === previous.removing) ? previous.removing : null } : previous);
      const offer = peekSecretOffer({ ownerUserId: userId, fileTo: "kyc_identity_documents" });
      const item = next.find(value => value.id === offer?.secretId);
      if (item) setFiling(previous => ({ owner, item, state: attempts.states.get(item.id) ??
        (previous?.owner === owner && previous.item.id === item.id ? previous.state : "idle") }));
    } catch {
      if (isCurrent() && request === owner.reads) setSnapshot(previous => ({ owner, items: previous?.owner === owner ? previous.items : [], loading: false, failed: true }));
    }
  }, [isCurrent, vaultKey, vaultOwnerToken, userId, owner, attempts]);
  useEffect(() => { void refresh(); }, [refresh]);
  useLayoutEffect(() => {
    setSnapshot(null); setSelection(null); setFiling(null);
  }, [owner]);
  useLayoutEffect(() => {
    const visibility = () => {
      owner.live = false; owner.reads += 1;
      setSnapshot(null); setSelection(null); setFiling(null); setVisibilityEpoch(value => value + 1);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [owner]);
  const beforeEffect = async () => { if (!isCurrent()) throw new Error("secret_owner_retired"); };
  const remove = async () => {
    if (!target || !isCurrent() || owner.pending || local?.uncertain || !vaultKey || !vaultOwnerToken) return;
    owner.pending = true; change({ outcome: null });
    try {
      const removed = await SecretsVaultService.removeSecret({ userId, vaultKey, vaultOwnerToken, secretId: target.id, beforeEffect });
      if (!isCurrent()) return;
      if (!removed) { change({ uncertain: true, outcome: "Removal wasn’t confirmed. Refresh before trying again." }); return; }
      reveal.hide(target.id);
      setSnapshot(previous => previous?.owner === owner ? { ...previous, items: previous.items.filter(item => item.id !== target.id) } : previous);
      change({ removing: null, id: null, outcome: "Removed from Secrets" });
      // The committed removal is not turned into a failure if this refresh fails.
      await refresh();
    } catch { change({ uncertain: true, outcome: "Removal wasn’t confirmed. Refresh before trying again." }); }
    finally { owner.pending = false; change({}); }
  };
  const offer = (id: string) => {
    const item = items.find(value => value.id === id); const action = item && secretOfferFor(item);
    if (!item || !action || !isCurrent() || owner.pending) return null;
    stageSecretOffer({ ownerUserId: userId, secretId: id, fileTo: action.fileTo });
    if (action.fileTo === "kyc_identity_documents") setFiling({ owner, item, state: attempts.states.get(item.id) ?? "idle" });
    return action.fileTo;
  };
  const currentFiling = allowed && filing?.owner === owner ? { ...filing, state: attempts.states.get(filing.item.id) ?? filing.state } : null;
  const file = async () => {
    if (!currentFiling || currentFiling.state !== "idle" || !isCurrent() || owner.pending || !vaultKey || !vaultOwnerToken) return;
    const item = currentFiling.item;
    if (attempts.states.has(item.id) || peekSecretOffer({ ownerUserId: userId, fileTo: "kyc_identity_documents" })?.secretId !== item.id) return;
    attempts.states.set(item.id, "filing");
    owner.pending = true; setFiling({ owner, item, state: "filing" });
    let committed = false;
    let dispatched = false;
    try {
      const number = await SecretsVaultService.revealSecret({ userId, vaultKey, vaultOwnerToken, secretId: item.id });
      await beforeEffect();
      if (!number) throw new Error("secret_missing");
      dispatched = true;
      const result = await KycIdentityDocumentsService.fileDocument({ userId, vaultKey, vaultOwnerToken,
        documentType: identityDocumentTypeFor(item.patternId), number, label: item.label, beforeEffect, sourceSecretId: item.id });
      committed = result.success;
      attempts.states.set(item.id, committed ? "filed" : "failed");
      renderSettlement(value => value + 1);
      if (!isCurrent()) return;
      if (!committed) throw new Error("filing_unconfirmed");
      // Marking the source is bookkeeping, not permission to repeat the committed filing.
      setFiling({ owner, item, state: "filed" });
      if (peekSecretOffer({ ownerUserId: userId, fileTo: "kyc_identity_documents" })?.secretId === item.id) clearSecretOffer();
      await SecretsVaultService.markFiled({ userId, vaultKey, vaultOwnerToken, secretId: item.id, filedTo: "kyc_identity_documents", beforeEffect }).catch(() => false);
      if (isCurrent()) await refresh();
    } catch {
      if (dispatched) attempts.states.set(item.id, committed ? "filed" : "failed"); else attempts.states.delete(item.id);
      renderSettlement(value => value + 1);
      if (isCurrent()) setFiling({ owner, item, state: committed ? "filed" : "failed" });
    }
    finally { owner.pending = false; change({}); }
  };
  const value = selected ? reveal.revealed[selected.id] ?? null : null;
  const exposed = useRef({ owner, id: selected?.id, value });
  useLayoutEffect(() => { exposed.current = { owner, id: selected?.id, value }; }, [owner, selected?.id, value]);
  const hide = (id: string) => { if (exposed.current.owner === owner && exposed.current.id === id) exposed.current.value = null; reveal.hide(id); };
  const copy = useSecretValueControls({ label: selected?.label ?? "Secret", value: value ?? "", active: native && !!value && isCurrent(),
    countdown: false, identity: value ? `${selected?.id}:${value}` : null,
    onHide: () => { if (selected) hide(selected.id); }, isCurrent: () => isCurrent() && !!value && !!selected &&
      exposed.current.owner === owner && exposed.current.id === selected.id && exposed.current.value === value });
  return { items, panelItems: items.map(secretPanelItem), locked: reveal.locked, revealed: reveal.revealed, busyId: reveal.busyId,
    loading: allowed && (snapshot?.owner !== owner || snapshot.loading), failed: snapshot?.owner === owner && snapshot.failed,
    selected, target, value, pending: owner.pending || currentFiling?.state === "filing", uncertain: !!local?.uncertain, outcome: local?.outcome, copy,
    lifetime: owner, current: isCurrent, refresh, reveal: (id: string) => isCurrent() && items.some(item => item.id === id) ? reveal.reveal(id) : Promise.resolve(),
    hide, select: (id: string | null) => { if (owner.pending) return; if (selected) hide(selected.id); change({ id, removing: null, outcome: null }); },
    askRemove: (id: string | null) => { if (!owner.pending) change({ removing: id, outcome: null }); }, remove, offer,
    filing: currentFiling, file,
    dismissFiling: () => { if (!isCurrent() || owner.pending) return;
      if (peekSecretOffer({ ownerUserId: userId, fileTo: "kyc_identity_documents" })?.secretId === currentFiling?.item.id) clearSecretOffer(); setFiling(null); },
  };
}
export type SecretsListModel = ReturnType<typeof useSecretsListModel>;
