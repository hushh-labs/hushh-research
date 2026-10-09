import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import type { WalletCardPayload } from "@/lib/services/wallet-card-service";
import { walletProfileUsername } from "@/lib/wallet/wallet-profile-username";
import styles from "./wallet-demo-cards.module.css";
import { WalletCardQr } from "@/components/wallet-card/wallet-card-qr";

export type WalletDemoProfile = {
  ownerId?: string;
  shareToken?: string | null;
  displayName: string | null;
  shareUrl: string | null;
  cardPayload?: WalletCardPayload | null;
  memberSince?: string | null;
  walletId?: string | null;
  referralUrl?: string | null;
};

/** System cards have stable identities separate from encrypted payment records. */
const AGENT_CARDS = [
  { id: "agent-one-profile", name: "Agent One Profile", kind: "Profile", finish: "profile" },
  { id: "agent-one-referral", name: "Agent One Referral", kind: "Referral", finish: "referral" },
  { id: "agent-one-nws", name: "Agent One NWS", kind: "NWS", finish: "nws" },
] as const;

// Compatibility export: these are now live identity surfaces, not sample bank cards.
export const WALLET_DEMO_CARDS: WalletCardSummary[] = AGENT_CARDS.map((card) => ({
  cardId: card.id,
  nickname: card.name,
  brand: "other",
  last4: "",
  expiryMonth: 0,
  expiryYear: 0,
  issuingRegion: "",
  createdAt: "",
}));

export function isAgentWalletCard(cardId: string): boolean {
  return AGENT_CARDS.some((card) => card.id === cardId);
}

export function WalletDemoCardFace({ summary, profile }: { summary: WalletCardSummary; profile?: WalletDemoProfile | null; onArtworkLoad?: () => void }) {
  const card = AGENT_CARDS.find((item) => item.id === summary.cardId);
  if (!card) return <WalletCardFace summary={summary} collection />;
  const username = profile?.cardPayload?.username || walletProfileUsername(profile?.displayName ?? "");
  const memberDate = profile?.memberSince ? new Date(profile.memberSince) : null;
  const memberSince = memberDate && !Number.isNaN(memberDate.getTime()) ? memberDate.getFullYear() : "—";
  const isNws = card.kind === "NWS";
  const walletId = profile?.walletId ? profile.walletId.slice(-8).toUpperCase() : "—";
  const qrUrl = card.kind === "Referral" ? profile?.referralUrl : profile?.shareUrl;
  return <div className={`@container ${styles.face}`}>
    <div data-testid="wallet-card-face" data-agent-card={card.finish} data-revealed="false" className={`${styles.artworkFrame} ${styles[card.finish]}`}>
      {isNws ? <span className="sr-only">Sample NWS score: 900 out of 1000. This is not an evaluated net worth score.</span> : null}
      <iframe title={`${card.name} artwork`} aria-hidden="true" tabIndex={-1} src={`/wallet/agent-one-card-${card.finish}.html?v=${isNws ? 5 : 4}`} className={styles.artwork} />
      {!isNws ? qrUrl ? <WalletCardQr value={qrUrl} label={`${card.name} QR code`} className={styles.profileQr} /> : <span className={styles.qrPlaceholder} aria-label="QR unavailable">QR</span> : null}
      {isNws ? <svg viewBox="0 0 1080 650" preserveAspectRatio="none" aria-hidden="true" className={styles.nwsIdentityFields}>
        <g fill="#9DBFA9" fontSize="14" fontWeight="500" letterSpacing="4.48">
          <text x="100" y="449">USERNAME</text>
          <text x="390" y="449">MEMBER SINCE</text>
          <text x="640" y="449">WALLET ID</text>
        </g>
        <g fill="none" stroke="#3F7A5E" strokeOpacity=".7" strokeWidth="1.5">
          <line x1="344" y1="428" x2="344" y2="507" />
          <line x1="594" y1="428" x2="594" y2="507" />
        </g>
        <g fill="#F2EFE3" fontWeight="600">
          <text x="100" y="495" fontSize="28" letterSpacing="4.48" textLength={username.length > 10 ? 220 : undefined} lengthAdjust="spacingAndGlyphs">{username}</text>
          <text x="390" y="495" fontSize="32" letterSpacing="1.28">{memberSince}</text>
          <text x="640" y="495" fontSize="32" letterSpacing="1.28">{walletId}</text>
        </g>
      </svg> : null}
      <dl className={isNws ? "sr-only" : styles.identityFields}>
        <div><dt>Username</dt><dd>{username}</dd></div>
        <div><dt>Member since</dt><dd>{memberSince}</dd></div>
        <div><dt>Wallet ID</dt><dd>{walletId}</dd></div>
      </dl>
    </div>
  </div>;
}

/** Kept for the Add illustration: owner details use WalletCardWorkspace. */
export function WalletDemoCardDetails({ cardId, profile }: { cardId: string; profile?: WalletDemoProfile | null }) {
  const card = AGENT_CARDS.find((item) => item.id === cardId);
  if (!card) return null;
  return <section aria-label={`${card.name} details`} className={styles.details} data-testid="wallet-demo-details">
    <h3 className="ui-text-section-title">{card.name}</h3>
    <p className="mt-1 text-sm text-muted-foreground">{profile?.displayName || "Your profile, ready to share."}</p>
  </section>;
}
