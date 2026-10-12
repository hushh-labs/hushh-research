"use client";

import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import type { NativeDrawerRow } from "@/lib/capacitor/native-drawers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { PROFILE_PANE_SHOWN_EVENT } from "@/lib/navigation/profile-pane";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";

export type ProfileMenuEntry = { id: string; label: string; symbol: string; destructive?: boolean; activate: () => void | Promise<void> };

/** Explicit authored port. Identity information is private presentation only;
 * native receives no URL, credential, permission or executable operation. */
export function NativeProfileMenu({ owner, ready, open, name, email, entries, onClose }: {
  owner: string; ready: boolean; open: boolean; name: string; email: string | null;
  entries: readonly ProfileMenuEntry[]; onClose: () => void;
}) {
  const renderer = useNativeDrawerPresentation({ family: "profile", owner, vaultEpoch: snapshotVaultSessionEpoch(), ready, open,
    title: "Profile", onPresented: () => window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT)), project: () => {
      const rows = new Map(entries.map(entry => [entry.id, entry.activate]));
      const account = entries.find(entry => entry.id === "account");
      if (account) rows.set("identity", account.activate);
      const identity: NativeDrawerRow = { id: "identity", label: name, ...(email ? { detail: email } : {}), symbol: "person.crop.circle", enabled: ready };
      return { sections: [
        { id: "identity-section", rows: [identity] },
        { id: "settings", rows: entries.map(({ activate: _activate, ...entry }) => ({ ...entry, enabled: ready })) },
      ], actions: { rows, open: () => undefined, close: onClose } };
    } });
  // Confirmed absence is not a silent successful Open. Keep failures in a
  // bounded app-owned page; an uncertain native retirement remains isolated.
  // Do not paint a full-height React drawer over retained native chrome.
  if (renderer !== "web" || !open) return null;
  return <NativeFeaturePage open title="Profile" owner={owner} context="profile-presentation-failure" onBack={onClose}>
    <p role="status" className="p-4 text-muted-foreground">Profile couldn’t open. Go back and try again.</p>
  </NativeFeaturePage>;
}
