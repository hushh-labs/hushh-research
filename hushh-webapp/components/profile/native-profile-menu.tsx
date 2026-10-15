"use client";

import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import type { NativeDrawerRow } from "@/lib/capacitor/native-drawers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { PROFILE_PANE_SHOWN_EVENT } from "@/lib/navigation/profile-pane";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { type ProfileMenuActions, profileMenuGroups } from "./profile-menu-model";
import { useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";

export function projectNativeProfileMenu(name: string, email: string | null, ready: boolean,
  groups: ReturnType<typeof profileMenuGroups>, actions: ProfileMenuActions, onClose: () => void) {
  const rows = new Map<string, () => void | Promise<void>>(groups.flatMap(group => group.entries.map(entry => [entry.id, actions[entry.id]] as const)));
  rows.set("identity", actions.account);
  const identity: NativeDrawerRow = { id: "identity", label: name, ...(email ? { detail: email } : {}), symbol: "person.crop.circle", enabled: ready };
  return { sections: [
    { id: "identity-section", rows: [identity] },
    ...groups.map(group => ({ id: group.id, title: group.title, rows: group.entries.map(entry => ({
      id: entry.id, label: entry.label, symbol: entry.symbol, chevron: true,
      ...("iconHex" in entry ? { iconHex: entry.iconHex } : {}),
      ...("destructive" in entry ? { destructive: entry.destructive } : {}),
      ...("localOnly" in entry ? { trailing: "Local" } : {}), enabled: ready,
    })) })),
  ], actions: { rows, open: () => undefined, close: onClose } };
}

/** Explicit authored port. Identity information is private presentation only;
 * native receives no URL, credential, permission or executable operation. */
export function NativeProfileMenu({ owner, ready, open, surfaceOpen, name, email, groups, actions, onClose, onPresented }: {
  owner: string; ready: boolean; open: boolean; name: string; email: string | null;
  surfaceOpen?: boolean;
  groups: ReturnType<typeof profileMenuGroups>; actions: ProfileMenuActions; onClose: () => void;
  onPresented?: () => void;
}) {
  const renderer = useNativeDrawerPresentation({ family: "profile", owner, vaultEpoch: snapshotVaultSessionEpoch(), ready, open,
    title: "Profile", profileMenuRows: true, surfaceOpen, onPresented: () => {
      window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
      onPresented?.();
    },
    project: () => projectNativeProfileMenu(name, email, ready, groups, actions, onClose) });
  // Confirmed absence is not a silent successful Open. Keep failures in a
  // bounded app-owned page; an uncertain native retirement remains isolated.
  // Do not paint a full-height React drawer over retained native chrome.
  if (renderer !== "web" || !open) return null;
  return <NativeFeaturePage open title="Profile" owner={owner} context="profile-presentation-failure" onBack={onClose}>
    <p role="status" className="p-4 text-muted-foreground">Profile couldn’t open. Go back and try again.</p>
  </NativeFeaturePage>;
}

/** Two-way presentation handoff. The outgoing surface stays painted until the
 * incoming owner acknowledges admission. Query changes never dismiss Profile
 * onto the underlying route while a bridge command is still in flight. */
export function NativeProfilePresentation({ lifetime, detail, menu, page, children }: {
  lifetime: string;
  detail: boolean;
  menu: Omit<ComponentProps<typeof NativeProfileMenu>, "onPresented">;
  page: Omit<ComponentProps<typeof NativeFeaturePage>, "open" | "onReady" | "children">;
  children: ReactNode;
}) {
  const [prepared, setPrepared] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!menu.surfaceOpen || !menu.ready) {
      setPrepared(null); setRestored(null);
    } else if (detail) {
      setRestored(null);
    }
  }, [menu.surfaceOpen, menu.ready, detail, lifetime]);
  const holdingDetail = !detail && prepared === lifetime && restored !== lifetime;
  const active = menu.surfaceOpen === true && menu.ready;
  return <>
    <NativeProfileMenu {...menu} open={active && (!detail || prepared !== lifetime)} onPresented={() => {
      if (active && !detail) { setRestored(lifetime); setPrepared(null); }
    }} />
    <NativeFeaturePage {...page} open={active && (detail || holdingDetail)} onReady={() => {
      if (active && detail) setPrepared(lifetime);
    }}>
      <div inert={holdingDetail || undefined}>
        {children}
      </div>
    </NativeFeaturePage>
  </>;
}
