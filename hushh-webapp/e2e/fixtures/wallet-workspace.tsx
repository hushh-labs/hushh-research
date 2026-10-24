import React from "react";
import { unwindBackLayer } from "../../lib/navigation/back-layers";
(window as unknown as { __walletBack: () => boolean }).__walletBack = () => unwindBackLayer("/one/wallet");
import { PublicWalletCardView, normalizePublicWalletCard } from "../../components/wallet-card/public-card-view";
import { createRoot } from "react-dom/client";

import { WalletWorkspace } from "../../components/wallet/wallet-workspace";
import { WalletEncryptedCardViewer } from "../../components/wallet/wallet-encrypted-card-viewer";
import { AppPageShell, AppPageContentRegion } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { TopShellTabs } from "../../components/app-ui/top-shell-tabs";
import { TOP_SHELL_TAB_REGISTRY } from "../../lib/navigation/top-shell-tabs";
import { Switch } from "../../components/ui/switch";
import { CalendarConnectHero } from "../../components/calendar/calendar-connect-hero";
import { WalletCardFace } from "../../components/wallet/wallet-card-face";
import { PAYMENT_CARD_ARTWORK, paymentCardArtwork } from "../../lib/wallet/wallet-payment-card-artwork";
import { SwipeViews } from "../../lib/morphy-ux/ui/swipe-views";

const MOTION_TABS = [
  { value: "cards", label: "Cards" },
  { value: "add", label: "Add" },
  { value: "sharing", label: "Sharing" },
];

// Isolate the shared spring from Wallet form rendering. Full Wallet behavior
// stays covered by the workspace cases below; these panes keep real tab/pager
// selection and a middle snap, where the previous spring overshot.
function SharedPagerMotion() {
  const [value, setValue] = React.useState("cards");
  return <AppPageShell width="agent" fitContent><AppPageContentRegion>
    <TopShellTabs tabSet={{ id: "wallet", label: "Wallet", queryParam: "view", activeValue: value,
      tabs: MOTION_TABS.map(tab => ({ ...tab, href: "/one/wallet" })) }} onValueChange={setValue} />
    <SwipeViews tabSetId="wallet" activeValue={value} options={MOTION_TABS}
      onSelectionChange={setValue} heightMode="active" viewportMinHeight="0px">
      {MOTION_TABS.map(tab => <div key={tab.value} style={{ height: 300 }}>{tab.label} panel</div>)}
    </SwipeViews>
  </AppPageContentRegion></AppPageShell>;
}

const reference = (window as unknown as {
  __workspaceHeaderReference?: boolean;
}).__workspaceHeaderReference;
const calendarHeading = (window as unknown as { __calendarHeading?: boolean }).__calendarHeading;

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

const root = createRoot(document.getElementById("root")!);
const visitor = (window as unknown as { __visitorPreview?: { photo: string; long?: boolean; shared?: boolean } }).__visitorPreview;
function VisitorPreview() {
  const card = normalizePublicWalletCard({
    fullName: visitor?.long ? "Alexandra Catherine Montgomery-Wellington" : "Alex Morgan",
    headline: "Product designer", organisation: "Hushh", locationLabel: "Bengaluru, India",
    email: visitor?.long ? "alexandra.montgomery.wellington@example.com" : "alex@example.com", phone: "+91 98765 43210",
    summary: "Designing thoughtful digital experiences. Always happy to connect and exchange ideas.",
    skills: ["Product design", "Research", "Strategy"], website: "https://example.com", avatarUrl: visitor?.photo,
  })!;
  const profileUrl = "https://one.hushh.ai/c/abcdefghijklmnop";
  return <AppPageShell width="agent" fitContent><AppPageContentRegion>
    <PublicWalletCardView card={card} embedded visualCard={visitor?.shared} profileUrl={visitor?.shared ? undefined : profileUrl} />
  </AppPageContentRegion></AppPageShell>;
}
let revision = 0;
window.__walletRemount = () => root.render(<WalletWorkspace key={++revision} />);
root.render((window as unknown as { __walletPagerOnly?: boolean }).__walletPagerOnly ? <SharedPagerMotion /> : visitor ? <VisitorPreview /> : calendarHeading ? (
  <AppPageShell width="reading" headerContentSpacing="compact">
    <AppPageContentRegion>
      <CalendarConnectHero journeyVariant="workspace" busy={false} needsReauth={false} onConnect={() => {}} />
    </AppPageContentRegion>
  </AppPageShell>
) : (window as unknown as { __encryptedCardReader?: boolean }).__encryptedCardReader ? <WalletEncryptedCardViewer /> : window.__walletScenario?.artworkGallery ? <ArtworkGallery /> : reference ? (
  // Frozen shared workspace geometry predating Location's top-shell title.
  // This protects Wallet's unchanged body header without reconstructing Location.
  <AppPageShell width="agent" headerContentSpacing="compact" fitContent className="relative isolate [--app-page-content-bottom-gap:0px]">
    <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-hidden">
      <div data-wallet-hub data-workspace-header-reference className="mx-auto w-full max-w-[820px] space-y-[var(--page-header-section-gap)]">
        <PageHeader title="Reference" titleRole="agent" actionsInlineMobile className="[&>div:first-child]:!gap-2.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center"
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
