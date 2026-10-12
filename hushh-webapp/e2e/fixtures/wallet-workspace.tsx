import React from "react";
import { WalletAddCollection } from "../../components/wallet/wallet-add-collection";
import { WALLET_DEMO_CARDS, WalletDemoCardFace } from "../../components/wallet/wallet-demo-cards";
import { WalletProfileCard } from "../../components/wallet-card/wallet-profile-card";
import { walletProfilePresentation } from "../../components/wallet-card/wallet-profile-presentation";
import { createRoot } from "react-dom/client";

import { WalletWorkspace } from "../../components/wallet/wallet-workspace";
import { WalletEncryptedCardViewer } from "../../components/wallet/wallet-encrypted-card-viewer";
import { AppPageShell, AppPageContentRegion } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { TopShellTabs } from "../../components/app-ui/top-shell-tabs";
import { TOP_SHELL_TAB_REGISTRY } from "../../lib/navigation/top-shell-tabs";
import { Switch } from "../../components/ui/switch";
import { WalletCardFace } from "../../components/wallet/wallet-card-face";
import { PAYMENT_CARD_ARTWORK, paymentCardArtwork } from "../../lib/wallet/wallet-payment-card-artwork";

const reference = (window as unknown as {
  __locationReference?: { hubClass: string; headerClass: string };
}).__locationReference;

function ArtworkGallery() {
  const ids = new Map<string, string>();
  for (let index = 0; ids.size < PAYMENT_CARD_ARTWORK.length && index < 1000; index += 1) {
    const id = `artwork-fixture-${index}`;
    ids.set(paymentCardArtwork(id).id, id);
  }
  const holder = "ALEXANDRA RIVERA-WASHINGTON DE LA CRUZ ".repeat(3).slice(0, 80);
  return <div style={{ padding: 16, display: "grid", gap: 24 }}>
    {PAYMENT_CARD_ARTWORK.flatMap((artwork) => [false, true].map((revealed) => <WalletCardFace
      key={`${artwork.id}-${revealed}`}
      summary={{ cardId: ids.get(artwork.id)!, nickname: "A VERY LONG CARD LABEL THAT MUST FIT THE FACE", brand: "unionpay", last4: "1234", expiryMonth: 12, expiryYear: 2032, issuingRegion: "US", createdAt: "2026-10-09T00:00:00Z" }}
      cardholderName={holder}
      revealed={revealed ? { pan: "6200000000000001234", cardholderName: holder } : undefined}
    />))}
  </div>;
}

function ProfileGallery() {
  const profile = walletProfilePresentation({ cardPayload: { full_name: "Alexandra Rivera-Washington de la Cruz", email: "alexandra.rivera.washington@example.com", phone: "+44 7700 900123", organisation: "Independent Design and Research Organization", headline: "Product designer" }, shareUrl: "https://one.hushh.ai/c/abcdefghijklmnopqrstuvwxyz1234567890" });
  if (window.__walletScenario?.profileDeck) return <div style={{ padding: 16, maxWidth: 480 }}><WalletAddCollection cards={WALLET_DEMO_CARDS} selectedCardId={null} onSelect={() => {}} onAdd={() => {}} onRemove={() => {}} busyCardId={null} initialExpanded showActions={false} renderCard={card => <WalletDemoCardFace summary={card} profile={{ displayName: profile.name, shareUrl: profile.authorizedProfileUrl, cardPayload: { email: profile.email, phone: profile.phone, headline: profile.professionalTitle } }} />} /></div>;
  return <div style={{ padding: 16, display: "grid", gap: 24, maxWidth: 480, margin: "0 auto" }}>
    <div className="@container"><WalletProfileCard profile={profile} compact /></div>
    <WalletProfileCard profile={profile} />
    <WalletProfileCard profile={walletProfilePresentation()} />
  </div>;
}

const root = createRoot(document.getElementById("root")!);
let revision = 0;
window.__walletRemount = () => root.render(<WalletWorkspace key={++revision} />);
root.render((window.__walletScenario?.profileGallery || window.__walletScenario?.profileDeck) ? <ProfileGallery /> : (window as unknown as { __encryptedCardReader?: boolean }).__encryptedCardReader ? <WalletEncryptedCardViewer /> : window.__walletScenario?.artworkGallery ? <ArtworkGallery /> : reference ? (
  <AppPageShell width="agent" fitContent className="relative isolate [--app-page-content-bottom-gap:0px]">
    <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-hidden">
      <div data-location-hub className={reference.hubClass}>
        <PageHeader title="Location" titleRole="agent" actionsInlineMobile className={reference.headerClass}
          actions={<div className="ml-auto flex min-h-0 w-[92px] shrink-0 flex-col items-center justify-center overflow-visible">
            <Switch size="ios" aria-label="Location" />
            <button className="mt-1 block w-full whitespace-nowrap text-center font-[family-name:var(--font-app-body)] text-[13px] font-medium leading-[18px] tracking-[-0.01em] text-[color:var(--app-secondary-label)]">Location off</button>
          </div>}
        />
        <TopShellTabs tabSet={{ ...TOP_SHELL_TAB_REGISTRY.location, activeValue: "now" }} />
      </div>
    </AppPageContentRegion>
  </AppPageShell>
) : <WalletWorkspace />);
