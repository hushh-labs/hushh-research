"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import type { NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { useProfileVaultMethodsModel } from "./use-profile-vault-methods-model";
import { presentVaultMethods } from "./vault-method-presentation";

class VaultMethodVisit {
  private live = false;
  constructor(readonly owner: string | null, readonly enabled: boolean) {}
  activate() { this.live = this.enabled; }
  retire() { this.live = false; }
  isCurrent() { return this.live; }
}

/** The native stack projects existing Vault operations. Native receives friendly
 * labels and opaque action handles, never wrapper material or owner authority. */
export function useNativeVaultMethods(model: ReturnType<typeof useProfileVaultMethodsModel>, active: boolean, mutable: boolean) {
  const [selection, setSelection] = useState<string | null>(null);
  const visit = useMemo(() => new VaultMethodVisit(model.owner, active), [active, model.owner]);
  useLayoutEffect(() => { visit.activate(); return () => visit.retire(); }, [visit]);
  const options = useMemo(() => presentVaultMethods(model.wrappers, model.capability?.biometricLabel, model.localBiometricId),
    [model.wrappers, model.capability?.biometricLabel, model.localBiometricId]);
  useLayoutEffect(() => { if (!active) setSelection(null); }, [active]);
  const selected = options.find(option => option.id === selection);
  const primary = (wrapper: (typeof options)[number]["wrapper"]) => model.primaryWrapperId !== null &&
    wrapper.method === model.primaryMethod && (wrapper.wrapperId ?? "default") === (model.primaryWrapperId ?? "default");
  const ready = active && mutable && !model.busy && !model.loading && !model.needsRefresh;
  const recommended = model.capability?.recommendedMethod;
  const rows = new Map<string, () => void | Promise<void>>();
  const page: NativeProfilePage = { id: "vault", title: "Vault methods", sections: [{ id: "vault-method-list", rows: [
    ...(model.notice ? [{ id: "vault-outcome", label: model.notice, enabled: true, readOnly: true }] : []),
    ...(model.loading ? [{ id: "vault-loading", label: "Loading unlock methods…", enabled: false, pending: true, readOnly: true }] : []),
    ...(model.needsRefresh ? [{ id: "vault-refresh", label: "Refresh methods", enabled: !model.busy, chevron: true }] : []),
    ...options.map(option => ({ id: option.id, label: option.label, artworkId: option.wrapper.method === "passphrase" ? "vault-password" : "vault-methods",
      enabled: !model.busy && !model.loading, chevron: true, ...(primary(option.wrapper) ? { trailing: "Default" } : {}) })),
    ...(recommended && recommended !== "passphrase" ? [{ id: "vault-add", label: recommended === "generated_default_native_biometric"
      ? `Add ${model.capability?.biometricLabel || "biometrics"}` : options.some(option => option.wrapper.method !== "passphrase") ? "Add another passkey" : "Add passkey",
      enabled: ready, chevron: true, artworkId: "vault-methods" }] : []),
    { id: "vault-password", label: "Change password", enabled: ready, chevron: true, artworkId: "vault-password" },
  ] }] };
  rows.set("vault-refresh", () => { void model.refresh(); });
  rows.set("vault-add", () => { if (ready && recommended && recommended !== "passphrase") void model.add(recommended); });
  rows.set("vault-password", model.openPassword);
  for (const option of options) rows.set(option.id, () => { if (visit.isCurrent() && !model.busy) setSelection(option.id); });
  const pages = [page];
  if (model.removal) {
    pages.push({ id: "vault-remove", title: "Remove passkey?", sections: [{ id: "vault-removal", rows: [
      { id: "vault-removal-copy", label: "Password remains available. Removing this passkey from One may not remove it from your password manager.", enabled: true, readOnly: true },
      { id: "vault-removal-confirm", label: model.busy ? "Removing…" : "Remove passkey", enabled: ready, pending: model.busy, destructive: true },
      { id: "vault-removal-cancel", label: "Cancel", enabled: !model.busy },
    ] }] });
    rows.set("vault-removal-confirm", () => { if (ready) void model.remove(); });
    rows.set("vault-removal-cancel", model.cancelRemove);
  } else if (selected) {
    pages.push({ id: "vault-method", title: selected.label, sections: [{ id: "vault-method-details", rows: [
      ...(selected.wrapper.passkeyRpId ? [{ id: "vault-method-website", label: "Website", detail: selected.wrapper.passkeyRpId, enabled: true, readOnly: true }] : []),
      primary(selected.wrapper) ? { id: "vault-default-status", label: "Default unlock", enabled: true, readOnly: true, selected: true } :
        { id: "vault-use-default", label: "Use as default", enabled: ready, chevron: true },
      ...(selected.wrapper.method !== "passphrase" && selected.wrapper.method !== "generated_default_native_biometric"
        ? [{ id: "vault-remove", label: "Remove passkey", enabled: ready, destructive: true, chevron: true }] : []),
    ] }] });
    rows.set("vault-use-default", () => { if (ready && !primary(selected.wrapper)) void model.select(selected.wrapper); });
    rows.set("vault-remove", () => { if (ready) { setSelection(null); model.requestRemove(selected.wrapper); } });
  }
  const back = () => {
    if (model.busy) return true;
    if (model.removal) { model.cancelRemove(); return true; }
    if (selected) { setSelection(null); return true; }
    return false;
  };
  return { pages, rows, back, nested: !!selected || !!model.removal };
}
