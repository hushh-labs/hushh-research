"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useNativeWorkspace, type NativeWorkspaceContent } from "@/lib/capacitor/use-native-workspace";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { WalletCardWorkspace } from "@/components/wallet-card/wallet-card-workspace";
import { NativeWalletAccessPanel } from "./native-wallet-access-panel";
import { NativeWalletIdentityPanel } from "./native-wallet-identity-panel";
import { NativeWalletReferralPanel } from "./native-wallet-referral-panel";
import { useNativeWalletArtwork } from "./use-native-wallet-artwork";
import { useBackLayer } from "@/lib/navigation/back-layers";
import type { NativeWalletProfileDraft } from "@/lib/capacitor/native-wallet-profile-editor";
import { NativeWalletPaymentPanel, type WalletPanelProjection } from "./native-wallet-payment-panel";
import type { WalletCardBrowserProps } from "./wallet-card-browser";
import type { WalletNativeHistoryProjection } from "./wallet-sharing-history";
import { WALLET_DEMO_CARDS, isAgentWalletCard } from "./wallet-demo-cards";
import { cardNetworkLabel } from "./card-network-mark";

/** One route body and owned child slot. Private handles bind to the existing
 * callbacks, never URLs or operation parameters interpreted by native code. */
export function NativeWalletBrowser(props: WalletCardBrowserProps & { renderFallback: () => React.ReactNode }) {
  const pathname = usePathname();
  const { onOverview } = props;
  const artwork = useNativeWalletArtwork(props.demoProfile, props.artworks);
  const contentFrame = useRef<HTMLDivElement>(null);
  const [handle] = useState(() => {
    const handles = new Map<string, string>();
    return (key: string) => {
      let id = handles.get(key);
      if (!id) { id = crypto.randomUUID(); handles.set(key, id); }
      return id;
    };
  });
  const [selected, setSelected] = useState<string | null>(props.selectedCardId);
  const accessReturnTab = useRef<"cards" | "sharing">("cards");
  const [panel, setPanel] = useState<{ visit: string; value: WalletPanelProjection; signature: string } | null>(null);
  const [ports] = useState(() => {
    let currentPanel: WalletPanelProjection | null = null;
    return {
      replace: (next: WalletPanelProjection) => { currentPanel = next; },
      dispatch: (id: string, choice: NativeWorkspaceChoice) => currentPanel?.actions.get(id)?.(choice),
      back: () => currentPanel?.back(),
    };
  });
  const visit = useMemo(() => selected ? crypto.randomUUID() : null, [selected]);
  useLayoutEffect(() => { setSelected(props.selectedCardId); }, [props.selectedCardId]);
  const selectedCard = [...props.cards, ...WALLET_DEMO_CARDS].find(card => card.cardId === selected);
  const selectedPayment = props.cards.find(card => card.cardId === selected);
  const publish = useCallback((value: WalletPanelProjection) => {
    ports.replace(value);
    const signature = JSON.stringify({ title: value.title, busy: value.busy, collectionNavigation: value.collectionNavigation, visitor: value.visitor, sections: value.sections, search: value.search, qrData: value.qrData, imageData: value.imageData, editor: value.editor ? { draft: value.editor.draft, busy: value.editor.busy, error: value.editor.error } : null });
    setPanel(previous => previous?.visit === visit && previous.signature === signature ? previous : { visit: visit!, value, signature });
  }, [visit, ports]);
  const validRoute = pathname?.replace(/\/+$/, "") === "/one/wallet";
  const value = panel?.visit === visit ? panel.value : null;
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  for (const id of value?.actions.keys() ?? []) actions.set(id, choice => ports.dispatch(id, choice));
  const addId = handle("add"), closeId = handle("close"), accessId = handle("access");
  const accessSelected = selected === "wallet-access" && !!props.nativeHistoryContext;
  const onClose = useCallback(() => {
    const returnToSharing = selected === "wallet-access" && accessReturnTab.current === "sharing";
    setSelected(null);
    if (returnToSharing && props.onSharing) props.onSharing();
    else onOverview();
  }, [onOverview, props.onSharing, selected]);
  actions.set(addId, () => props.onAdd());
  if (props.nativeHistoryContext) actions.set(accessId, () => {
    accessReturnTab.current = props.activeTab ?? "cards";
    if (accessReturnTab.current === "sharing") onOverview();
    setSelected("wallet-access");
  });
  actions.set(closeId, choice => { if (choice.dismissed) onClose(); else ports.back(); });
  const cards = [...props.cards, ...WALLET_DEMO_CARDS].map(card => {
    const kind = card.cardId === "agent-one-profile" ? "profile" as const : card.cardId === "agent-one-referral" ? "referral" as const : card.cardId === "agent-one-nws" ? "nws" as const : "payment" as const;
    const id = handle(`card-${card.cardId}`);
    actions.set(id, () => {
      setSelected(card.cardId); props.onSelect(card.cardId);
    });
    return { id, kind, ...(artwork[card.cardId] ? { imageData: artwork[card.cardId], overlayDetails: kind === "payment" && props.artworks?.[card.cardId]?.source === "catalog" && (props.artworks[card.cardId] as Extract<NonNullable<typeof props.artworks>[string], { source: "catalog" }>).allowOverlay } : {}), title: card.nickname || cardNetworkLabel(card.brand), subtitle: kind === "payment" ? `${cardNetworkLabel(card.brand)} · •••• ${card.last4}` : kind === "profile" ? "Share your introduction" : kind === "referral" ? "Invite your people" : "Sample card",
      network: kind === "payment" ? cardNetworkLabel(card.brand) : "", last4: kind === "payment" ? card.last4 : "", holder: props.cardholderNames?.[card.cardId] ?? "", expiry: kind === "payment" ? `${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}` : "" };
  });
  const shared = handle("sharing"), owned = handle("cards-tab");
  actions.set(shared, () => props.onSharing?.());
  actions.set(owned, onClose);
  const collection = [...WALLET_DEMO_CARDS, ...props.cards];
  const selectedIndex = collection.findIndex(card => card.cardId === selectedCard?.cardId);
  const previousCard = collection[selectedIndex - 1], nextCard = collection[selectedIndex + 1];
  const navigation = value?.collectionNavigation && selectedCard ? {
    sectionId: handle("detail-navigation"), allId: handle("all-cards"), previousId: handle("previous-card"),
    nextId: handle("next-card"), addId: handle("detail-add"), position: selectedIndex + 1, total: collection.length,
  } : undefined;
  if (navigation) {
    actions.set(navigation.allId, onClose);
    actions.set(navigation.addId, () => props.onAdd());
    if (previousCard) actions.set(navigation.previousId, () => { setSelected(previousCard.cardId); props.onSelect(previousCard.cardId); });
    if (nextCard) actions.set(navigation.nextId, () => { setSelected(nextCard.cardId); props.onSelect(nextCard.cardId); });
  }
  const detailSections = value && navigation ? [...value.sections, { id: navigation.sectionId, rows: [
    { id: navigation.allId, label: "All cards", enabled: !value.busy },
    { id: navigation.previousId, label: "Previous card", enabled: !value.busy && !!previousCard },
    { id: navigation.nextId, label: "Next card", enabled: !value.busy && !!nextCard },
    { id: navigation.addId, label: "Add a card", enabled: !value.busy && !props.addDisabled },
  ] }] : value?.sections;
  const pendingSections = props.nativePending ? [{ id: handle("pending-section"), rows: [
    { id: handle("pending-status"), label: props.nativePending.label, enabled: false, readOnly: true },
    ...(props.nativePending.retry ? [{ id: handle("pending-retry"), label: "Retry save", enabled: true }] : []),
    ...(props.nativePending.dismiss ? [{ id: handle("pending-dismiss"), label: "Dismiss", enabled: true }] : []),
  ] }] : [];
  if (props.nativePending?.retry) actions.set(handle("pending-retry"), () => props.nativePending?.retry?.());
  if (props.nativePending?.dismiss) actions.set(handle("pending-dismiss"), () => props.nativePending?.dismiss?.());
  const activeTab = props.activeTab ?? "cards";
  const sharedSections: NativeWorkspaceContent["sections"] = props.sharedHistory?.sections.map(section => ({
    id: handle(`history-section-${section.id}`),
    ...(section.title ? { title: section.title } : {}),
    rows: section.rows.map(row => {
      const id = handle(`history-row-${row.id}`);
      if (row.readOnly !== true) actions.set(id, () => props.sharedHistory?.activate(row.id));
      return { ...row, id };
    }),
  })) ?? [{ id: handle("history-section-loading"), title: "Shared with me", rows: [
    { id: handle("history-row-loading"), label: "Loading shared cards…", enabled: false, readOnly: true },
  ] }];
  const content: NativeWorkspaceContent = {
    workspace: "wallet", page: "overview", title: activeTab === "sharing" ? props.sharedHistory?.title ?? "Shared with me" : "Your cards",
    enabled: props.active !== false && validRoute && !props.disabled,
    backEnabled: false, sections: activeTab === "sharing" ? sharedSections : detailSections ?? pendingSections,
    ...(activeTab !== "sharing" && value?.search ? { search: value.search } : {}),
    tabs: { label: "Wallet", options: [{ id: owned, label: "My cards", selected: activeTab === "cards" }, { id: shared, label: "Shared with me", selected: activeTab === "sharing" }] },
    wallet: { cards: activeTab === "sharing" ? [] : cards, addId, ...(props.nativeHistoryContext ? { accessId } : {}), sharedTabId: shared, view: activeTab,
      addEnabled: !props.addDisabled && !props.disabled,
      selectedId: activeTab === "sharing" ? null : accessSelected ? accessId : selectedCard ? handle(`card-${selectedCard.cardId}`) : null,
      detailVisitId: activeTab === "sharing" ? null : (accessSelected || selectedCard) ? visit : null, closeId,
      detailTitle: value?.title ?? (accessSelected ? "Wallet access" : selectedCard?.nickname || "Your card"),
      detailBusy: (accessSelected || !!selectedCard) && !value || (value?.busy ?? false),
      ...(navigation ? { navigation } : {}),
      ...(value?.visitor ? { visitor: value.visitor } : {}),
      ...(value?.qrData ? { detailQrData: value.qrData } : {}), ...(value?.imageData ? { detailImageData: value.imageData } : {}) },
  };
  const phase = useNativeWorkspace<NativeWalletProfileDraft>({ owner: props.ownerId!, content, actions, current: () => validRoute,
    active: validRoute && (props.active !== false || props.nativeAddPresented === true),
    covered: props.active === false && props.nativeAddPresented === true,
    presentationOwner: props.presentationOwner,
    back: onClose, contentFrame, editorKind: "wallet-profile", editor: value?.editor });
  useBackLayer("/one/wallet", phase === "native" && validRoute && props.active !== false && (props.activeTab !== "sharing" && selectedCard || accessSelected) ? 1 : 0, () => { ports.back(); return true; });
  if (phase === "web" && !props.presentationOwner?.getSnapshot().held) return props.renderFallback();
  return <>
    <AppPageShell as="div" ref={contentFrame} width="standard" aria-busy={phase === "checking"} data-native-wallet-workspace={phase} />
    {accessSelected ? <NativeWalletAccessPanel ownerId={props.ownerId!} getContext={props.nativeHistoryContext!} handle={key => handle(`access-${key}`)} publish={publish} onClose={onClose} /> : selectedCard?.cardId === "agent-one-referral" ? <NativeWalletReferralPanel summary={props.referralSummary ?? null} profile={props.demoProfile} shareToken={props.demoProfile?.shareToken ?? null}
      failed={props.referralError} onRetry={props.onRetryReferral} onRevoke={props.onRevokeReferral} handle={key => handle(`${selectedCard.cardId}-${key}`)} publish={publish} onClose={onClose} /> :
      selectedCard && isAgentWalletCard(selectedCard.cardId) ? <WalletCardWorkspace embedded passVariant={selectedCard.cardId === "agent-one-nws" ? "nws" : "profile"}
        nativeRender={model => <NativeWalletIdentityPanel model={model} variant={selectedCard.cardId === "agent-one-nws" ? "nws" : "profile"} handle={key => handle(`${selectedCard.cardId}-${key}`)} publish={publish} onClose={onClose} />} /> :
      selectedPayment && props.nativeOperations ? <NativeWalletPaymentPanel key={selectedPayment.cardId} card={selectedPayment} active={props.active !== false}
      name={props.cardholderNames?.[selectedPayment.cardId]} operations={props.nativeOperations} disabled={!!props.disabled}
      handle={key => handle(`${selectedPayment.cardId}-${key}`)} publish={publish} onClose={onClose} /> : null}
  </>;
}
