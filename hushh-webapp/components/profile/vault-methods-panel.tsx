"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon } from "@/components/icons";
import { FingerprintProfileIcon, PassphraseRowIcon, VaultRowIcon } from "@/components/icons/agents";
import { SettingsGroup, SettingsRow, SettingsDetailPanel } from "@/components/app-ui/settings-ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { VaultMethod, VaultWrapper } from "@/lib/services/vault-service";

export function vaultMethodLabel(wrapper: VaultWrapper, biometricLabel?: string, localBiometricId?: string | null) {
  if (wrapper.method === "passphrase") return "Passphrase";
  if (wrapper.method === "generated_default_native_biometric") {
    return (wrapper.wrapperId ?? "default") === localBiometricId ? biometricLabel || "Biometrics" : "Device biometrics";
  }
  return wrapper.passkeyDeviceLabel || (wrapper.passkeyProvider === "webauthn_prf" ? "Browser passkey" : "Device passkey");
}

/** Presentation only: exact wrapper authority remains in the owning Profile
 * handlers. Opaque option handles keep credential-derived IDs out of the DOM. */
export function VaultMethodsPanel({ wrappers, primaryMethod, primaryWrapperId, biometricLabel, localBiometricId,
  mutable, busy, needsRefresh, onSelect, onRemove, onAdd, addLabel, onChangePassphrase, onRefresh }: {
  wrappers: VaultWrapper[]; primaryMethod: VaultMethod | null; primaryWrapperId: string | null;
  biometricLabel?: string; localBiometricId?: string | null; mutable: boolean; busy: boolean; needsRefresh: boolean;
  onSelect: (wrapper: VaultWrapper) => void; onRemove: (wrapper: VaultWrapper) => void;
  onAdd?: () => void; addLabel?: string; onChangePassphrase: () => void; onRefresh: () => void;
}) {
  const handles = useRef(new Map<string, string>());
  const [selected, setSelected] = useState<string | null>(null);
  const options = useMemo(() => {
    const labels = wrappers.map((wrapper) => vaultMethodLabel(wrapper, biometricLabel, localBiometricId));
    const occurrences = new Map<string, number>();
    return wrappers.map((wrapper, index) => {
      const key = `${wrapper.method}:${wrapper.wrapperId ?? "default"}`;
      const id = handles.current.get(key) ?? crypto.randomUUID();
      handles.current.set(key, id);
      const label = labels[index] ?? vaultMethodLabel(wrapper, biometricLabel, localBiometricId);
      const ordinal = (occurrences.get(label) ?? 0) + 1;
      occurrences.set(label, ordinal);
      return { wrapper, id, label: labels.filter((candidate) => candidate === label).length > 1 ? `${label} ${ordinal}` : label };
    });
  }, [wrappers, biometricLabel, localBiometricId]);
  useEffect(() => { setSelected(null); }, [mutable]);
  const isPrimary = (wrapper: VaultWrapper) => primaryWrapperId !== null && wrapper.method === primaryMethod &&
    (wrapper.wrapperId ?? "default") === (primaryWrapperId ?? "default");
  const primary = options.find(({ wrapper }) => isPrimary(wrapper));
  const detail = options.find(({ id }) => id === selected);
  const disabled = !mutable || busy || needsRefresh;

  return <>
      <SettingsRow icon={VaultRowIcon} iconTone="capability" title="Default unlock" trailing={
        <Select value={primary?.id ?? ""} disabled={disabled} onValueChange={(id) => {
          const option = options.find((candidate) => candidate.id === id);
          if (option && !disabled && !isPrimary(option.wrapper)) onSelect(option.wrapper);
        }}>
          <SelectTrigger aria-label="Default unlock" className="h-11 max-w-full border-0 bg-transparent shadow-none">
            <SelectValue placeholder={needsRefresh ? "Refresh to confirm" : "Choose a method"} />
          </SelectTrigger>
          <SelectContent>{options.map(({ id, label }) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent>
        </Select>
      } stackTrailingOnMobile />
      {needsRefresh ? <SettingsRow title="Refresh methods" chevron onClick={onRefresh} disabled={busy} /> : null}
      {onAdd ? <SettingsRow icon={FingerprintProfileIcon} iconTone="capability" title={addLabel || "Add passkey"}
        chevron disabled={disabled} onClick={onAdd} /> : null}
      {options.filter(({ wrapper }) => wrapper.method !== "passphrase").map(({ wrapper, id, label }) =>
        <SettingsRow key={id} icon={FingerprintProfileIcon} iconTone="capability" title={label}
          chevron disabled={busy} onClick={() => setSelected(id)}
          trailing={isPrimary(wrapper) ? <CheckIcon className="size-4 text-[color:var(--app-accent)]" aria-label="Default unlock" /> : undefined} />)}
      <SettingsRow icon={PassphraseRowIcon} iconTone="capability" title="Change passphrase"
        chevron disabled={disabled} onClick={onChangePassphrase} />
    <SettingsDetailPanel open={!!detail} onOpenChange={(open) => { if (!open) setSelected(null); }}
      title={detail?.label ?? "Unlock method"} mobilePresentation="sheet" headerTextOverflow="wrap">
      {detail ? <SettingsGroup>
        {detail.wrapper.passkeyRpId ? <SettingsRow title="Website" description={detail.wrapper.passkeyRpId} /> : null}
        {isPrimary(detail.wrapper) ? <SettingsRow title="Default unlock" trailing={<CheckIcon className="size-4" aria-label="Selected" />} /> :
          <SettingsRow title="Use as default" disabled={disabled} chevron onClick={() => { if (!disabled) onSelect(detail.wrapper); }} />}
        {detail.wrapper.method !== "generated_default_native_biometric" ?
          <SettingsRow title="Remove passkey" disabled={disabled} chevron onClick={() => {
            if (disabled) return;
            setSelected(null);
            onRemove(detail.wrapper);
          }} /> : null}
      </SettingsGroup> : null}
    </SettingsDetailPanel>
  </>;
}
