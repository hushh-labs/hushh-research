"use client";

import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import { nativeDrawers, nativeDrawerAcknowledged, hasNativeProfileScene, type NativeDrawerRow, type NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { PROFILE_PANE_SHOWN_EVENT } from "@/lib/navigation/profile-pane";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { expectNativeProfilePreparation, nativePrivacyCanPrepareProfile, nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import type { ProfilePreparationDescription, ProfilePreparationScene } from "@/lib/capacitor/native-profile-preparation";
import { type ProfileMenuActions, profileMenuGroups } from "./profile-menu-model";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";

export function projectNativeProfileMenu(name: string, email: string | null, ready: boolean,
  groups: ReturnType<typeof profileMenuGroups>, actions: ProfileMenuActions, onClose: NativeDrawerActions["close"]) {
  const rows = new Map<string, () => void | Promise<void>>(groups.flatMap(group => group.entries.map(entry => [entry.id, actions[entry.id]] as const)));
  rows.set("identity", actions.account);
  const identity: NativeDrawerRow = { id: "identity", label: name, ...(email ? { detail: email } : {}), symbol: "person.crop.circle", enabled: ready };
  return { sections: [
    { id: "identity-section", rows: [identity] },
    ...groups.map(group => ({ id: group.id, title: group.title, rows: group.entries.map(entry => ({
      id: entry.id, label: entry.label, symbol: entry.symbol, chevron: true,
      ...("destructive" in entry ? { destructive: entry.destructive } : {}),
      ...("localOnly" in entry ? { trailing: "Local" } : {}), enabled: ready,
    })) })),
  ], actions: { rows, open: () => undefined, close: onClose } };
}

/** Explicit authored port. Identity information is private presentation only;
 * native receives no URL, credential, permission or executable operation. */
export function NativeProfileMenu({ owner, ready, open, surfaceOpen, enabled, navigationLocked, name, email, portrait, groups, actions, onClose, onPresented, onHidden, fallbackOwned, stack, preparation }: {
  owner: string; ready: boolean; open: boolean; name: string; email: string | null;
  surfaceOpen?: boolean;
  enabled?: boolean;
  navigationLocked?: boolean;
  portrait?: string;
  groups: ReturnType<typeof profileMenuGroups>; actions: ProfileMenuActions; onClose: NativeDrawerActions["close"];
  onPresented?: (destinationId: string | undefined, privacyGeneration: number) => void;
  onHidden?: (privacyGeneration: number) => void;
  fallbackOwned?: boolean;
  preparation?: ProfilePreparationDescription;
  stack?: { pages: readonly NativeProfilePage[]; destinationId?: string; supportDestinationId?: string; rows: NativeDrawerActions["rows"]; back: () => void; root?: () => void; ancestor?: NativeDrawerActions["ancestor"] };
}) {
  const [portraitSupported, setPortraitSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    void nativeDrawerAcknowledged(nativeDrawers().getCapabilities()).then(value => {
      if (current) setPortraitSupported(value.contractVersion === 1 && value.profilePortrait === true);
    }).catch(() => { if (current) setPortraitSupported(false); });
    return () => { current = false; };
  }, []);
  const renderer = useNativeDrawerPresentation({ family: "profile", owner, vaultEpoch: snapshotVaultSessionEpoch(), ready: ready && portraitSupported !== null, open,
    title: "Profile", profileMenuRows: true, surfaceOpen, enabled, preparation,
    onHidden: state => onHidden?.(state.privacyGeneration), onAbsenceConfirmed: onHidden, onPresented: state => {
      window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
      onPresented?.(state.profileDestinationId ?? state.profileSupportDestinationId, state.privacyGeneration);
    },
    project: () => {
      const projected = projectNativeProfileMenu(name, email, ready, groups, actions, onClose);
      const sections = portraitSupported ? projected.sections.map(section => ({ ...section,
        rows: section.rows.map(row => row.id === "identity" ? { ...row, portrait: true,
          ...(portrait ? { portraitData: portrait } : {}) } : row),
      })) : projected.sections;
      if (!stack) return { ...projected, sections };
      // Additive capability: old wrappers keep their established ordinary row.
      const pages = portraitSupported ? stack.pages : stack.pages.map(page => ({ ...page, sections: page.sections.map(section => ({
        ...section, rows: section.rows.map(({ portrait: _portrait, portraitData: _data, ...row }) => {
          if (row.id !== "account-photo") return row;
          // Identity copy belongs beside the supported portrait, not beneath
          // an older wrapper's ordinary photo-action row. Mail has its own row.
          const { detail: _detail, ...photo } = row;
          return { ...photo, label: "Profile photo", artworkId: "account", chevron: true };
        }),
      })) }));
      return { ...projected, sections, ...(navigationLocked === undefined ? {} : { navigationLocked }), profileStack: pages, profileDestinationId: stack.destinationId,
        profileSupportDestinationId: stack.supportDestinationId, actions: { ...projected.actions,
        rows: new Map([...projected.actions.rows, ...stack.rows]), ...(stack.pages.length ? { back: stack.back } : {}), ...(stack.root ? { root: stack.root } : {}), ...(stack.ancestor ? { ancestor: stack.ancestor } : {}) } };
    } });
  // Confirmed absence is not a silent successful Open. Keep failures in a
  // bounded app-owned page; an uncertain native retirement remains isolated.
  // Do not paint a full-height React drawer over retained native chrome.
  if (renderer !== "web" || !open || fallbackOwned) return null;
  return <NativeFeaturePage open title="Profile" owner={owner} context="profile-presentation-failure" onBack={onClose}>
    <p role="status" className="p-4 text-muted-foreground">Profile couldn’t open. Go back and try again.</p>
  </NativeFeaturePage>;
}

/** Two-way presentation handoff. The outgoing surface stays painted until the
 * incoming owner acknowledges admission. Query changes never dismiss Profile
 * onto the underlying route while a bridge command is still in flight. */
export function NativeProfilePresentation({ lifetime, detail, menu, page, children, detailOverlay, account, settings, support, legal, phone, referrals, workspace, onVoiceCapability, onDevicesCapability, onVaultCapability, onPricingCapability, onPayoutCapability, onMemoryCapability, onSharedMemoryCapability, onSecretMemoryCapability, onFinanceCapability, onWorldModelCapability, onRuntimeCapability, onConnectorsCapability }: {
  lifetime: string;
  detail: boolean;
  menu: Omit<ComponentProps<typeof NativeProfileMenu>, "onPresented" | "onHidden" | "fallbackOwned">;
  page: Omit<ComponentProps<typeof NativeFeaturePage>, "open" | "onReady" | "children">;
  children: ReactNode;
  /** A rich detail's modal starts only after its parent plane is ready and
   * the native menu actually finishes leaving. Its overlay cannot block the
   * Back/Close controls required to prepare that same plane. */
  detailOverlay?: ReactNode;
  account?: { active: boolean; page: NativeProfilePage; confirmation?: NativeProfilePage; back?: () => void; root?: () => void;
    rows: NativeDrawerActions["rows"]; formScene?: ProfilePreparationScene | null; editor: (destinationId?: string) => ReactNode };
  settings?: { active: boolean; formScene?: ProfilePreparationScene | null; requiresVoice?: boolean; requiresFinance?: boolean; requiresDevices?: boolean; requiresVault?: boolean; requiresRuntime?: boolean; pages: readonly NativeProfilePage[]; rows: NativeDrawerActions["rows"]; back?: () => void; ancestor?: NativeDrawerActions["ancestor"]; root: () => void; editor?: (destinationId?: string) => ReactNode };
  onVoiceCapability?: (supported: boolean) => void;
  onDevicesCapability?: (supported: boolean) => void;
  onVaultCapability?: (supported: boolean) => void;
  onPricingCapability?: (supported: boolean) => void;
  onPayoutCapability?: (supported: boolean) => void;
  onMemoryCapability?: (supported: boolean) => void;
  onSharedMemoryCapability?: (supported: boolean) => void;
  onSecretMemoryCapability?: (supported: boolean) => void;
  onFinanceCapability?: (supported: boolean) => void;
  onWorldModelCapability?: (supported: boolean) => void;
  onRuntimeCapability?: (supported: boolean) => void;
  onConnectorsCapability?: (supported: boolean) => void;
  workspace?: { kind: "request-pricing" | "payouts" | "memory" | "world-model" | "connectors"; visitKey?: string; active: boolean; pages: readonly NativeProfilePage[]; rows: NativeDrawerActions["rows"]; root: () => void; back?: () => void; ancestor?: NativeDrawerActions["ancestor"];
    formScene?: ProfilePreparationScene | null; editor?: (destinationId: string) => ReactNode; onPresented?: () => void };
  support?: { active: boolean; editor: (destinationId: string, onFallback: () => void) => ReactNode };
  phone?: { active: boolean; editor: (options: { native: boolean; destinationId?: string; onFallback: () => void }) => ReactNode };
  legal?: { active: boolean; pages: readonly NativeProfilePage[]; rows: NativeDrawerActions["rows"]; root: () => void };
  referrals?: { active: boolean; pages: readonly NativeProfilePage[]; rows: NativeDrawerActions["rows"];
    root: () => void; formScene?: ProfilePreparationScene | null; editor: (destinationId: string, onFallback: () => void) => ReactNode };
}) {
  const [stackSupported, setStackSupported] = useState<boolean | null>(null);
  const [settingsSupported, setSettingsSupported] = useState(false);
  const [supportSupported, setSupportSupported] = useState(false);
  const [legalSupported, setLegalSupported] = useState(false);
  const [referralsSupported, setReferralsSupported] = useState(false);
  const [referralsFailedOwner, setReferralsFailedOwner] = useState<string | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [accountActionsSupported, setAccountActionsSupported] = useState(false);
  const [devicesSupported, setDevicesSupported] = useState(false);
  const [vaultSupported, setVaultSupported] = useState(false);
  const [pricingSupported, setPricingSupported] = useState(false);
  const [payoutSupported, setPayoutSupported] = useState(false);
  const [memorySupported, setMemorySupported] = useState(false);
  const [financeSupported, setFinanceSupported] = useState(false);
  const [worldModelSupported, setWorldModelSupported] = useState(false);
  const [runtimeSupported, setRuntimeSupported] = useState(false);
  const [connectorsSupported, setConnectorsSupported] = useState(false);
  const [phoneSupported, setPhoneSupported] = useState(false);
  const [phoneFailedVisit, setPhoneFailedVisit] = useState<string | null>(null);
  const [supportFailedOwner, setSupportFailedOwner] = useState<string | null>(null);
  const [presentedDestination, setPresentedDestination] = useState<{ id: string | undefined; privacy: number }>();
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const hasAccount = account !== undefined;
  useEffect(() => {
    if (!hasAccount) return;
    let current = true;
    const plugin = nativeDrawers();
    void nativeDrawerAcknowledged(plugin.getCapabilities()).then(capability => {
      if (current) {
        const completedPresentation = capability.presentationCompletion === true && typeof plugin.getPresentationState === "function";
        const navigation = completedPresentation && capability.contractVersion === 1 && capability.supported &&
          capability.wholePresentation && capability.profileMenuRows === true && capability.profileContentHandoff === true &&
          capability.profileNavigationStack === true;
        const stack = navigation && capability.profileNameScene === true && hasNativeProfileScene(plugin, "account-name");
        setStackSupported(stack);
        setAccountActionsSupported(stack && capability.profileAccountActions === true);
        const settings = stack && capability.profileSettingsPages === true && capability.profileStyleScene === true &&
          hasNativeProfileScene(plugin, "writing-style");
        setSettingsSupported(settings);
        setSupportSupported(stack && capability.profileSupportScene === true && hasNativeProfileScene(plugin, "support"));
        setPhoneSupported(stack && capability.profilePhoneScene === true && hasNativeProfileScene(plugin, "phone"));
        setLegalSupported(stack && capability.profileLegalReader === true);
        setReferralsSupported(stack && capability.profileReferralPages === true && typeof plugin.copyProfileReferralLink === "function");
        const voice = stack && capability.profileSettingsPages === true && capability.profileVoiceSettings === true;
        setVoiceSupported(voice); onVoiceCapability?.(voice);
        const devices = stack && capability.profileSettingsPages === true && capability.profileTrustedDevices === true;
        setDevicesSupported(devices); onDevicesCapability?.(devices);
        const vault = settings && capability.profileVaultMethods === true &&
          capability.profilePasswordScene === true && hasNativeProfileScene(plugin, "vault-passphrase");
        setVaultSupported(vault); onVaultCapability?.(vault);
        const pricing = stack && capability.profilePricingScene === true && hasNativeProfileScene(plugin, "request-price");
        setPricingSupported(pricing); onPricingCapability?.(pricing);
        const payout = stack && capability.profilePayoutPages === true;
        setPayoutSupported(payout); onPayoutCapability?.(payout);
        const memory = stack && capability.profileMemoryPages === true && capability.profileMemoryScene === true && hasNativeProfileScene(plugin, "memory-financial-context");
        setMemorySupported(memory); onMemoryCapability?.(memory);
        onSharedMemoryCapability?.(memory && capability.profileSharedMemoryPages === true);
        onSecretMemoryCapability?.(memory && capability.profileSecretMemoryPages === true);
        const finance = settings && capability.profileFinancePreferences === true;
        setFinanceSupported(finance); onFinanceCapability?.(finance);
        const worldModel = stack && capability.profileWorldModelPages === true && hasNativeProfileScene(plugin, "world-model");
        setWorldModelSupported(worldModel); onWorldModelCapability?.(worldModel);
        const runtime = settings && capability.profileRuntimeScene === true && hasNativeProfileScene(plugin, "runtime-provider");
        setRuntimeSupported(runtime); onRuntimeCapability?.(runtime);
        const connectors = stack && capability.profileConnectorPages === true && capability.profileConnectorScene === true && hasNativeProfileScene(plugin, "connector-custom-server");
        setConnectorsSupported(connectors); onConnectorsCapability?.(connectors);
      }
    }).catch(() => { if (current) { setStackSupported(false); setVoiceSupported(false); onVoiceCapability?.(false); setDevicesSupported(false); onDevicesCapability?.(false); setVaultSupported(false); onVaultCapability?.(false); setPricingSupported(false); onPricingCapability?.(false); setPayoutSupported(false); onPayoutCapability?.(false); setMemorySupported(false); onMemoryCapability?.(false); onSharedMemoryCapability?.(false); onSecretMemoryCapability?.(false); setFinanceSupported(false); onFinanceCapability?.(false); setWorldModelSupported(false); onWorldModelCapability?.(false); setRuntimeSupported(false); onRuntimeCapability?.(false); setConnectorsSupported(false); onConnectorsCapability?.(false); } });
    return () => { current = false; };
  }, [hasAccount, onVoiceCapability, onDevicesCapability, onVaultCapability, onPricingCapability, onPayoutCapability, onMemoryCapability, onSharedMemoryCapability, onSecretMemoryCapability, onFinanceCapability, onWorldModelCapability, onRuntimeCapability, onConnectorsCapability]);
  useEffect(() => { if (!phone?.active) setPhoneFailedVisit(null); }, [phone?.active]);
  const nativePhone = phoneSupported && phone?.active === true && phoneFailedVisit !== lifetime;
  const nativeAccount = stackSupported === true && account?.active === true && (!account.confirmation || accountActionsSupported) && (!phone?.active || nativePhone);
  const nativeSettings = settingsSupported && settings?.active === true && (!settings.requiresVoice || voiceSupported) && (!settings.requiresFinance || financeSupported) && (!settings.requiresDevices || devicesSupported) && (!settings.requiresVault || vaultSupported) && (!settings.requiresRuntime || runtimeSupported);
  const nativeSupport = supportSupported && support?.active === true && supportFailedOwner !== lifetime;
  const nativeLegal = legalSupported && legal?.active === true;
  const nativeReferrals = referralsSupported && referrals?.active === true && referralsFailedOwner !== lifetime;
  const nativeWorkspace = workspace?.active === true && (workspace.kind === "request-pricing" ? pricingSupported &&
    workspace.pages.length === 1 && workspace.pages[0]?.id === "request-pricing" : workspace.kind === "connectors" ? connectorsSupported && workspace.pages[0]?.id === "connectors" : workspace.kind === "payouts" ? payoutSupported && workspace.pages[0]?.id === "payouts" : workspace.kind === "world-model" ? worldModelSupported && workspace.pages[0]?.id === "world-model" : memorySupported && workspace.pages[0]?.id === "memory");
  const nativePath: readonly NativeProfilePage[] = nativeAccount ? [account!.page, ...(account!.confirmation ? [account!.confirmation] : [])] : nativeSettings ? settings!.pages : nativeLegal ? legal!.pages : nativeReferrals ? referrals!.pages : nativeWorkspace ? workspace!.pages : [];
  const destinationKey = nativeSupport ? JSON.stringify([menu.surfaceOpen, "support"]) :
    nativePath.length ? JSON.stringify([menu.surfaceOpen, nativePath.map(item => item.id), nativePhone ? "phone" : null, nativeWorkspace ? workspace?.visitKey : null]) : "";
  // A new destination visit gets a new token, including A → B → A. Compatible
  // theme/content updates preserve it; an old form cannot act in a later visit.
  const destinationId = useMemo(() => destinationKey && lifetime ? crypto.randomUUID() : undefined, [lifetime, destinationKey]);
  const parentAdmitted = presentedDestination?.id === destinationId && presentedDestination?.privacy === privacy?.generation &&
    nativePrivacyCanPrepareProfile(privacy);
  const webDetail = detail && !nativeAccount && !nativeSettings && !nativeSupport && !nativeLegal && !nativeReferrals && !nativeWorkspace;
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
  const preparationVisit = useMemo(() => ({ id: crypto.randomUUID(), lifetime, destinationId, active }), [lifetime, destinationId, active]);
  const expectedForm = nativePhone ? "phone" : nativeSupport ? "support" : nativeAccount ? account?.formScene :
    nativeSettings ? settings?.formScene : nativeWorkspace ? workspace?.formScene : nativeReferrals ? referrals?.formScene : null;
  const webVisit = useMemo(() => active && webDetail ? { id: crypto.randomUUID(), lifetime, context: page.context } : null,
    [active, webDetail, lifetime, page.context]);
  useLayoutEffect(() => expectNativeProfilePreparation(menu.owner, active, webVisit?.id ?? preparationVisit.id,
    webDetail ? null : expectedForm ?? null, webDetail ? "pane" : "drawer"),
    [menu.owner, active, webDetail, webVisit, preparationVisit, expectedForm]);
  const [readyWebVisit, setReadyWebVisit] = useState<string | null>(null);
  const [hiddenMenu, setHiddenMenu] = useState<{ lifetime: string; privacy: number } | null>(null);
  const menuPainted = active && (!webDetail || prepared !== lifetime);
  useLayoutEffect(() => {
    if (menuPainted || !active || privacy?.shielded || !privacy?.appIsActive) setHiddenMenu(null);
  }, [menuPainted, active, privacy?.shielded, privacy?.appIsActive, privacy?.generation]);
  const menuConcealed = hiddenMenu?.lifetime === lifetime && hiddenMenu.privacy === privacy?.generation ||
    privacy?.preparationAuthorized && privacy.preparationBody === "pane" && privacy.preparationVisitId === webVisit?.id && privacy.profileMenuConcealed;
  const overlayAdmitted = active && webDetail && webVisit !== null && readyWebVisit === webVisit.id && !menuPainted &&
    menuConcealed && nativePrivacyCanPrepareProfile(privacy);
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
    <NativeProfileMenu {...menu} open={menuPainted} fallbackOwned={active && webDetail}
      preparation={!webDetail ? { visitId: preparationVisit.id, formScene: expectedForm ?? null } : undefined}
      stack={stackSupported && account ? { pages: nativePath, destinationId: nativeSupport ? undefined : destinationId,
        supportDestinationId: nativeSupport ? destinationId : undefined,
        rows: new Map([...account.rows, ...(nativeSettings ? settings!.rows : []), ...(nativeLegal ? legal!.rows : []), ...(nativeReferrals ? referrals!.rows : []), ...(nativeWorkspace ? workspace!.rows : [])]), back: nativeAccount && account.back ? account.back : nativeSettings && settings?.back ? settings.back : nativeWorkspace && workspace?.back ? workspace.back : page.onBack,
        ...(nativeSettings && settings?.ancestor ? { ancestor: settings.ancestor } : nativeWorkspace && workspace?.ancestor ? { ancestor: workspace.ancestor } : {}),
        ...(nativeAccount && account.confirmation ? { root: account.root ?? account.back ?? page.onBack } : nativeSettings ? { root: settings!.root } : nativeLegal ? { root: legal!.root } : nativeWorkspace ? { root: workspace!.root } : {}) } : undefined}
      onHidden={privacyGeneration => {
        if (active && webDetail && !menuPainted) setHiddenMenu({ lifetime, privacy: privacyGeneration });
      }} onPresented={(appliedDestination, privacyGeneration) => {
      setPresentedDestination({ id: appliedDestination, privacy: privacyGeneration });
      if (nativeWorkspace && appliedDestination === destinationId && privacyGeneration === privacy?.generation &&
          privacy.shielded === false && privacy.appIsActive) workspace?.onPresented?.();
      if (active && !webDetail) { setRestored(lifetime); setPrepared(null); }
    }} />
    <NativeFeaturePage {...page} headerRenderer="web" admissionKey={webVisit?.id}
      preparation={webVisit ? { visitId: webVisit.id, ready: !!overlayAdmitted } : undefined} {...(retained ? {
      title: retained.title, context: retained.context, backLabel: retained.backLabel,
    } : {})} backEnabled={!holdingDetail} open={active && (webDetail || !!retained)} onReady={() => {
      if (active && webDetail) { setPrepared(lifetime); setReadyWebVisit(webVisit?.id ?? null); }
    }}>
      <div inert={holdingDetail || undefined}>
        {retained ? retained.children : children}
        {overlayAdmitted ? detailOverlay : null}
      </div>
    </NativeFeaturePage>
    {(!nativeAccount || parentAdmitted) && account?.editor(destinationId)}
    {nativeSettings && parentAdmitted && settings?.editor?.(destinationId)}
    {nativeWorkspace && destinationId && parentAdmitted && workspace?.editor?.(destinationId)}
    {nativeReferrals && destinationId && parentAdmitted && referrals?.editor(destinationId, () => setReferralsFailedOwner(lifetime))}
    {nativeSupport && destinationId && parentAdmitted && support?.editor(destinationId, () => setSupportFailedOwner(lifetime))}
    {phone?.active && phone.editor({ native: nativePhone, destinationId: nativePhone && parentAdmitted ? destinationId : undefined,
      onFallback: () => setPhoneFailedVisit(lifetime) })}
  </>;
}
