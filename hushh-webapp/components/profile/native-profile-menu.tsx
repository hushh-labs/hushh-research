"use client";

import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import { nativeDrawers, nativeDrawerAcknowledged, type NativeDrawerRow, type NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { PROFILE_PANE_SHOWN_EVENT } from "@/lib/navigation/profile-pane";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { type ProfileMenuActions, profileMenuGroups } from "./profile-menu-model";
import { useEffect, useLayoutEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";

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
export function NativeProfileMenu({ owner, ready, open, surfaceOpen, name, email, groups, actions, onClose, onPresented, stack }: {
  owner: string; ready: boolean; open: boolean; name: string; email: string | null;
  surfaceOpen?: boolean;
  groups: ReturnType<typeof profileMenuGroups>; actions: ProfileMenuActions; onClose: () => void;
  onPresented?: () => void;
  stack?: { pages: readonly NativeProfilePage[]; destinationId?: string; rows: NativeDrawerActions["rows"]; back: () => void };
}) {
  const renderer = useNativeDrawerPresentation({ family: "profile", owner, vaultEpoch: snapshotVaultSessionEpoch(), ready, open,
    title: "Profile", profileMenuRows: true, surfaceOpen, onPresented: () => {
      window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
      onPresented?.();
    },
    project: () => {
      const projected = projectNativeProfileMenu(name, email, ready, groups, actions, onClose);
      if (!stack) return projected;
      return { ...projected, profileStack: stack.pages, profileDestinationId: stack.destinationId, actions: { ...projected.actions,
        rows: new Map([...projected.actions.rows, ...stack.rows]), ...(stack.pages.length ? { back: stack.back } : {}) } };
    } });
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
export function NativeProfilePresentation({ lifetime, detail, menu, page, children, account }: {
  lifetime: string;
  detail: boolean;
  menu: Omit<ComponentProps<typeof NativeProfileMenu>, "onPresented">;
  page: Omit<ComponentProps<typeof NativeFeaturePage>, "open" | "onReady" | "children">;
  children: ReactNode;
  account?: { active: boolean; page: NativeProfilePage; rows: NativeDrawerActions["rows"]; editor: (destinationId?: string) => ReactNode };
}) {
  const [stackSupported, setStackSupported] = useState<boolean | null>(null);
  const hasAccount = account !== undefined;
  useEffect(() => {
    if (!hasAccount) return;
    let current = true;
    void nativeDrawerAcknowledged(nativeDrawers.getCapabilities()).then(capability => {
      if (current) setStackSupported(capability.contractVersion === 1 && capability.supported &&
        capability.profileNavigationStack === true && capability.profileNameScene === true);
    }).catch(() => { if (current) setStackSupported(false); });
    return () => { current = false; };
  }, [hasAccount]);
  const nativeAccount = stackSupported === true && account?.active === true;
  const destinationId = useMemo(() => nativeAccount && lifetime ? crypto.randomUUID() : undefined, [nativeAccount, lifetime]);
  const webDetail = detail && !nativeAccount;
  const [prepared, setPrepared] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  // Retain the committed display, not its operation authority. On Back the
  // caller already projects Profile root; rendering those new children while
  // native return is pending would visibly replace the outgoing detail.
  // Private bodies remain process-local and cannot cross an owner/vault lease.
  const [displayedDetail, setDisplayedDetail] = useState<{
    lifetime: string; children: ReactNode; title: string; context: string; backLabel?: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!menu.surfaceOpen || !menu.ready) {
      setPrepared(null); setRestored(null);
    } else if (webDetail) {
      setRestored(null);
    }
  }, [menu.surfaceOpen, menu.ready, webDetail, lifetime]);
  const holdingDetail = !webDetail && prepared === lifetime && restored !== lifetime;
  const active = menu.surfaceOpen === true && menu.ready;
  const retained = active && holdingDetail && displayedDetail?.lifetime === lifetime
    ? displayedDetail : null;
  useLayoutEffect(() => {
    if (active && webDetail) {
      setDisplayedDetail({ lifetime, children, title: page.title, context: page.context, backLabel: page.backLabel });
    } else if (!active || !holdingDetail) {
      setDisplayedDetail(null);
    } else {
      setDisplayedDetail(previous => previous?.lifetime === lifetime ? previous : null);
    }
  }, [active, webDetail, holdingDetail, lifetime, children, page.title, page.context, page.backLabel]);
  // Decide the composition before the first visible native menu. Do not first
  // display a legacy menu and replace it with a stack after capability discovery.
  if (account && stackSupported === null) return null;
  return <>
    <NativeProfileMenu {...menu} open={active && (!webDetail || prepared !== lifetime)}
      stack={stackSupported && account ? { pages: nativeAccount ? [account.page] : [], destinationId, rows: account.rows, back: page.onBack } : undefined}
      onPresented={() => {
      if (active && !webDetail) { setRestored(lifetime); setPrepared(null); }
    }} />
    <NativeFeaturePage {...page} {...(retained ? {
      title: retained.title, context: retained.context, backLabel: retained.backLabel,
    } : {})} backEnabled={!holdingDetail} open={active && (webDetail || !!retained)} onReady={() => {
      if (active && webDetail) setPrepared(lifetime);
    }}>
      <div inert={holdingDetail || undefined}>
        {retained ? retained.children : children}
      </div>
    </NativeFeaturePage>
    {account?.editor(destinationId)}
  </>;
}
