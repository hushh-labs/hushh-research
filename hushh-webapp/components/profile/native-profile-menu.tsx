"use client";

import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import { nativeDrawers, nativeDrawerAcknowledged, hasNativeProfileScene, type NativeDrawerRow, type NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { PROFILE_PANE_SHOWN_EVENT } from "@/lib/navigation/profile-pane";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { type ProfileMenuActions, profileMenuGroups } from "./profile-menu-model";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";

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
export function NativeProfileMenu({ owner, ready, open, surfaceOpen, enabled, name, email, groups, actions, onClose, onPresented, stack }: {
  owner: string; ready: boolean; open: boolean; name: string; email: string | null;
  surfaceOpen?: boolean;
  enabled?: boolean;
  groups: ReturnType<typeof profileMenuGroups>; actions: ProfileMenuActions; onClose: () => void;
  onPresented?: (destinationId: string | undefined, privacyGeneration: number) => void;
  stack?: { pages: readonly NativeProfilePage[]; destinationId?: string; supportDestinationId?: string; rows: NativeDrawerActions["rows"]; back: () => void; root?: () => void; ancestor?: NativeDrawerActions["ancestor"] };
}) {
  const renderer = useNativeDrawerPresentation({ family: "profile", owner, vaultEpoch: snapshotVaultSessionEpoch(), ready, open,
    title: "Profile", profileMenuRows: true, surfaceOpen, enabled, onPresented: state => {
      window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
      onPresented?.(state.profileDestinationId ?? state.profileSupportDestinationId, state.privacyGeneration);
    },
    project: () => {
      const projected = projectNativeProfileMenu(name, email, ready, groups, actions, onClose);
      if (!stack) return projected;
      return { ...projected, profileStack: stack.pages, profileDestinationId: stack.destinationId,
        profileSupportDestinationId: stack.supportDestinationId, actions: { ...projected.actions,
        rows: new Map([...projected.actions.rows, ...stack.rows]), ...(stack.pages.length ? { back: stack.back } : {}), ...(stack.root ? { root: stack.root } : {}), ...(stack.ancestor ? { ancestor: stack.ancestor } : {}) } };
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
export function NativeProfilePresentation({ lifetime, detail, menu, page, children, account, settings, support, legal, phone, onVoiceCapability, onDevicesCapability }: {
  lifetime: string;
  detail: boolean;
  menu: Omit<ComponentProps<typeof NativeProfileMenu>, "onPresented">;
  page: Omit<ComponentProps<typeof NativeFeaturePage>, "open" | "onReady" | "children">;
  children: ReactNode;
  account?: { active: boolean; page: NativeProfilePage; confirmation?: NativeProfilePage; back?: () => void; root?: () => void;
    rows: NativeDrawerActions["rows"]; editor: (destinationId?: string) => ReactNode };
  settings?: { active: boolean; requiresVoice?: boolean; requiresDevices?: boolean; pages: readonly NativeProfilePage[]; rows: NativeDrawerActions["rows"]; back?: () => void; ancestor?: NativeDrawerActions["ancestor"]; root: () => void; editor?: (destinationId?: string) => ReactNode };
  onVoiceCapability?: (supported: boolean) => void;
  onDevicesCapability?: (supported: boolean) => void;
  support?: { active: boolean; editor: (destinationId: string, onFallback: () => void) => ReactNode };
  phone?: { active: boolean; editor: (options: { native: boolean; destinationId?: string; onFallback: () => void }) => ReactNode };
  legal?: { active: boolean; pages: readonly NativeProfilePage[]; rows: NativeDrawerActions["rows"]; root: () => void };
}) {
  const [stackSupported, setStackSupported] = useState<boolean | null>(null);
  const [settingsSupported, setSettingsSupported] = useState(false);
  const [supportSupported, setSupportSupported] = useState(false);
  const [legalSupported, setLegalSupported] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [accountActionsSupported, setAccountActionsSupported] = useState(false);
  const [devicesSupported, setDevicesSupported] = useState(false);
  const [phoneSupported, setPhoneSupported] = useState(false);
  const [phoneFailedVisit, setPhoneFailedVisit] = useState<string | null>(null);
  const [supportFailedOwner, setSupportFailedOwner] = useState<string | null>(null);
  const [presentedDestination, setPresentedDestination] = useState<{ id: string | undefined; privacy: number }>();
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const hasAccount = account !== undefined;
  useEffect(() => {
    if (!hasAccount) return;
    let current = true;
    void nativeDrawerAcknowledged(nativeDrawers.getCapabilities()).then(capability => {
      if (current) {
        const completedPresentation = capability.presentationCompletion === true && typeof nativeDrawers.getPresentationState === "function";
        const navigation = completedPresentation && capability.contractVersion === 1 && capability.supported &&
          capability.wholePresentation && capability.profileMenuRows === true && capability.profileContentHandoff === true &&
          capability.profileNavigationStack === true;
        const stack = navigation && capability.profileNameScene === true && hasNativeProfileScene(nativeDrawers, "account-name");
        setStackSupported(stack);
        setAccountActionsSupported(stack && capability.profileAccountActions === true);
        setSettingsSupported(stack && capability.profileSettingsPages === true && capability.profileStyleScene === true &&
          hasNativeProfileScene(nativeDrawers, "writing-style"));
        setSupportSupported(stack && capability.profileSupportScene === true && hasNativeProfileScene(nativeDrawers, "support"));
        setPhoneSupported(stack && capability.profilePhoneScene === true && hasNativeProfileScene(nativeDrawers, "phone"));
        setLegalSupported(stack && capability.profileLegalReader === true);
        const voice = stack && capability.profileSettingsPages === true && capability.profileVoiceSettings === true;
        setVoiceSupported(voice); onVoiceCapability?.(voice);
        const devices = stack && capability.profileSettingsPages === true && capability.profileTrustedDevices === true;
        setDevicesSupported(devices); onDevicesCapability?.(devices);
      }
    }).catch(() => { if (current) { setStackSupported(false); setVoiceSupported(false); onVoiceCapability?.(false); setDevicesSupported(false); onDevicesCapability?.(false); } });
    return () => { current = false; };
  }, [hasAccount, onVoiceCapability, onDevicesCapability]);
  useEffect(() => { if (!phone?.active) setPhoneFailedVisit(null); }, [phone?.active]);
  const nativePhone = phoneSupported && phone?.active === true && phoneFailedVisit !== lifetime;
  const nativeAccount = stackSupported === true && account?.active === true && (!account.confirmation || accountActionsSupported) && (!phone?.active || nativePhone);
  const nativeSettings = settingsSupported && settings?.active === true && (!settings.requiresVoice || voiceSupported) && (!settings.requiresDevices || devicesSupported);
  const nativeSupport = supportSupported && support?.active === true && supportFailedOwner !== lifetime;
  const nativeLegal = legalSupported && legal?.active === true;
  const nativePath: readonly NativeProfilePage[] = nativeAccount ? [account!.page, ...(account!.confirmation ? [account!.confirmation] : [])] : nativeSettings ? settings!.pages : nativeLegal ? legal!.pages : [];
  const destinationKey = nativeSupport ? JSON.stringify([menu.surfaceOpen, "support"]) :
    nativePath.length ? JSON.stringify([menu.surfaceOpen, nativePath.map(item => item.id), nativePhone ? "phone" : null]) : "";
  // A new destination visit gets a new token, including A → B → A. Compatible
  // theme/content updates preserve it; an old form cannot act in a later visit.
  const destinationId = useMemo(() => destinationKey && lifetime ? crypto.randomUUID() : undefined, [lifetime, destinationKey]);
  const parentAdmitted = presentedDestination?.id === destinationId && presentedDestination?.privacy === privacy?.generation &&
    privacy?.shielded === false && privacy.appIsActive;
  const webDetail = detail && !nativeAccount && !nativeSettings && !nativeSupport && !nativeLegal;
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
      stack={stackSupported && account ? { pages: nativePath, destinationId: nativeSupport ? undefined : destinationId,
        supportDestinationId: nativeSupport ? destinationId : undefined,
        rows: new Map([...account.rows, ...(nativeSettings ? settings!.rows : []), ...(nativeLegal ? legal!.rows : [])]), back: nativeAccount && account.back ? account.back : nativeSettings && settings?.back ? settings.back : page.onBack,
        ...(nativeSettings && settings?.ancestor ? { ancestor: settings.ancestor } : {}),
        ...(nativeAccount && account.confirmation ? { root: account.root ?? account.back ?? page.onBack } : nativeSettings ? { root: settings!.root } : nativeLegal ? { root: legal!.root } : {}) } : undefined}
      onPresented={(appliedDestination, privacyGeneration) => {
      setPresentedDestination({ id: appliedDestination, privacy: privacyGeneration });
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
    {(!nativeAccount || parentAdmitted) && account?.editor(destinationId)}
    {nativeSettings && parentAdmitted && settings?.editor?.(destinationId)}
    {nativeSupport && destinationId && parentAdmitted && support?.editor(destinationId, () => setSupportFailedOwner(lifetime))}
    {phone?.active && phone.editor({ native: nativePhone, destinationId: nativePhone && parentAdmitted ? destinationId : undefined,
      onFallback: () => setPhoneFailedVisit(lifetime) })}
  </>;
}
