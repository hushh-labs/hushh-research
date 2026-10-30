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
import { WALLET_DEMO_CARDS, isAgentWalletCard } from "./wallet-demo-cards";
import { cardNetworkLabel } from "./card-network-mark";

/** One route body and owned child slot. Private handles bind to the existing
 * callbacks, never URLs or operation parameters interpreted by native code. */
export function NativeWalletBrowser(props: WalletCardBrowserProps & { onFallback: () => void }) {
  const pathname = usePathname();
  const { onFallback, onOverview } = props;
  const artwork = useNativeWalletArtwork(props.demoProfile, props.artworks);
  const current = useRef(true);
  const mounted = useRef(true);
  const contentFrame = useRef<HTMLDivElement>(null);
  const retirement = useRef<(() => Promise<boolean>) | null>(null);
  const [handle] = useState(() => {
    const handles = new Map<string, string>();
    return (key: string) => {
      let id = handles.get(key);
      if (!id) { id = crypto.randomUUID(); handles.set(key, id); }
      return id;
    };
  });
  const [selected, setSelected] = useState<string | null>(props.selectedCardId);
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
  const onClose = useCallback(() => { setSelected(null); onOverview(); }, [onOverview]);
  const publish = useCallback((value: WalletPanelProjection) => {
    ports.replace(value);
    const signature = JSON.stringify({ title: value.title, busy: value.busy, sections: value.sections, search: value.search, qrData: value.qrData, imageData: value.imageData, editor: value.editor ? { draft: value.editor.draft, busy: value.editor.busy, error: value.editor.error } : null });
    setPanel(previous => previous?.visit === visit && previous.signature === signature ? previous : { visit: visit!, value, signature });
  }, [visit, ports]);
  useLayoutEffect(() => {
    current.current = true; mounted.current = true;
    return () => { current.current = false; mounted.current = false; };
  }, []);
  const validRoute = pathname?.replace(/\/+$/, "") === "/one/wallet";
  const value = panel?.visit === visit ? panel.value : null;
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  for (const id of value?.actions.keys() ?? []) actions.set(id, choice => ports.dispatch(id, choice));
  const addId = handle("add"), closeId = handle("close"), accessId = handle("access");
  const accessSelected = selected === "wallet-access" && !!props.nativeHistoryContext;
  actions.set(addId, () => props.onAdd());
  if (props.nativeHistoryContext) actions.set(accessId, () => setSelected("wallet-access"));
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
  actions.set(handle("all-cards"), onClose);
  const collection = [...WALLET_DEMO_CARDS, ...props.cards];
  const nextCard = selectedCard && collection[collection.findIndex(card => card.cardId === selectedCard.cardId) + 1];
  const nextCardId = handle("next-card");
  if (nextCard) actions.set(nextCardId, () => { setSelected(nextCard.cardId); props.onSelect(nextCard.cardId); });
  const detailSections = value && selectedCard ? [...value.sections, { id: handle("detail-navigation"), rows: [
    { id: handle("all-cards"), label: "All cards", enabled: !value.busy },
    ...(nextCard ? [{ id: nextCardId, label: "Next card", enabled: !value.busy, chevron: true }] : []),
  ] }] : value?.sections;
  const pendingSections = props.nativePending ? [{ id: handle("pending-section"), rows: [
    { id: handle("pending-status"), label: props.nativePending.label, enabled: false, readOnly: true },
    ...(props.nativePending.retry ? [{ id: handle("pending-retry"), label: "Retry save", enabled: true }] : []),
    ...(props.nativePending.dismiss ? [{ id: handle("pending-dismiss"), label: "Dismiss", enabled: true }] : []),
  ] }] : [];
  if (props.nativePending?.retry) actions.set(handle("pending-retry"), () => props.nativePending?.retry?.());
  if (props.nativePending?.dismiss) actions.set(handle("pending-dismiss"), () => props.nativePending?.dismiss?.());
  const content: NativeWorkspaceContent = {
    workspace: "wallet", page: "overview", title: "Your cards", enabled: props.active !== false && validRoute && !props.disabled,
    backEnabled: false, sections: detailSections ?? pendingSections, ...(value?.search ? { search: value.search } : {}),
    tabs: { label: "Wallet", options: [{ id: owned, label: "My cards", selected: true }, { id: shared, label: "Shared with me", selected: false }] },
    wallet: { cards, addId, ...(props.nativeHistoryContext ? { accessId } : {}), addEnabled: !props.addDisabled && !props.disabled, selectedId: accessSelected ? accessId : selectedCard ? handle(`card-${selectedCard.cardId}`) : null,
      detailVisitId: (accessSelected || selectedCard) ? visit : null, closeId, detailTitle: value?.title ?? (accessSelected ? "Wallet access" : selectedCard?.nickname || "Your card"), detailBusy: (accessSelected || !!selectedCard) && !value || (value?.busy ?? false), ...(value?.qrData ? { detailQrData: value.qrData } : {}), ...(value?.imageData ? { detailImageData: value.imageData } : {}) },
  };
  const phase = useNativeWorkspace<NativeWalletProfileDraft>({ owner: props.ownerId!, content, actions, current: () => current.current && validRoute,
    back: onClose, contentFrame, editorKind: "wallet-profile", editor: value?.editor, onRetirementOwner: revoke => { retirement.current = revoke; if (!current.current) void revoke().then(absent => { if (absent && mounted.current) onFallback(); }); } });
  useLayoutEffect(() => {
    if ((props.active !== false || props.nativeAddPresented) && validRoute) return;
    current.current = false;
    void retirement.current?.().then(absent => { if (absent && mounted.current) onFallback(); });
  }, [props.active, props.nativeAddPresented, validRoute, onFallback]);
  useBackLayer("/one/wallet", props.active !== false && (selectedCard || accessSelected) ? 1 : 0, () => { ports.back(); return true; });
  useLayoutEffect(() => { if (phase === "web") onFallback(); }, [phase, onFallback]);
  return <>
    <AppPageShell as="div" ref={contentFrame} width="standard" aria-busy={phase === "checking"} data-native-wallet-workspace={phase} />
    {accessSelected ? <NativeWalletAccessPanel ownerId={props.ownerId!} getContext={props.nativeHistoryContext!} handle={key => handle(`access-${key}`)} publish={publish} onClose={onClose} /> : selectedCard?.cardId === "agent-one-referral" ? <NativeWalletReferralPanel summary={props.referralSummary ?? null} profile={props.demoProfile} shareToken={props.demoProfile?.shareToken ?? null}
      failed={props.referralError} onRetry={props.onRetryReferral} onRevoke={props.onRevokeReferral} handle={key => handle(`${selectedCard.cardId}-${key}`)} publish={publish} onClose={onClose} /> :
      selectedCard && isAgentWalletCard(selectedCard.cardId) ? <WalletCardWorkspace embedded passVariant={selectedCard.cardId === "agent-one-nws" ? "nws" : "profile"}
        nativeRender={model => <NativeWalletIdentityPanel model={model} variant={selectedCard.cardId === "agent-one-nws" ? "nws" : "profile"} handle={key => handle(`${selectedCard.cardId}-${key}`)} publish={publish} onClose={onClose} />} /> :
      selectedPayment && props.nativeOperations ? <NativeWalletPaymentPanel key={selectedPayment.cardId} card={selectedPayment}
      name={props.cardholderNames?.[selectedPayment.cardId]} operations={props.nativeOperations} disabled={!!props.disabled}
      handle={key => handle(`${selectedPayment.cardId}-${key}`)} publish={publish} onClose={onClose} /> : null}
  </>;
}
