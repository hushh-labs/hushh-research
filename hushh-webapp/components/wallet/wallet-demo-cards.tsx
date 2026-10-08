import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import type { WalletCardPayload } from "@/lib/services/wallet-card-service";
import styles from "./wallet-demo-cards.module.css";
import { WalletCardQr } from "@/components/wallet-card/wallet-card-qr";

export type WalletDemoProfile = {
  displayName: string | null;
  shareUrl: string | null;
  cardPayload?: WalletCardPayload | null;
};

/** Fixed illustration records, never accepted as saved Wallet cards. */
const DEMOS = [
  { name: "Everyday", brand: "visa", number: "0000000000004242", month: 12, finish: "platinum", tier: "Platinum" },
  { name: "Travel", brand: "mastercard", number: "0000000000004444", month: 9, finish: "gold", tier: "Signature" },
  { name: "Rewards", brand: "visa", number: "0000000000001234", month: 6, finish: "graphite", tier: "Black" },
] as const;

export const WALLET_DEMO_CARDS: WalletCardSummary[] = DEMOS.map((demo, index) => ({
  cardId: `demo-${index}`,
  nickname: demo.name,
  brand: demo.brand,
  last4: demo.number.slice(-4),
  expiryMonth: demo.month,
  expiryYear: 2030,
  issuingRegion: "",
  createdAt: "",
}));

function demoFor(cardId: string) {
  const index = WALLET_DEMO_CARDS.findIndex((card) => card.cardId === cardId);
  return DEMOS[index];
}

/** Only the preview branch calls this; real cards never receive these numbers. */
export function WalletDemoCardFace({ summary, profile }: { summary: WalletCardSummary; profile?: WalletDemoProfile | null }) {
  const demo = demoFor(summary.cardId);
  if (!demo) return <WalletCardFace summary={summary} collection />;
  // All supplied card artwork represents the same user's wallet identity. Keep
  // the artwork-specific finish and layout, but overlay the live profile name
  // and profile QR on every card variant (Profile, Referral, and NWS).
  const profileArtwork = profile;
  return (
    <div className={`${styles.face} ${styles[demo.finish]}`} data-demo-card="true">
      <div className="@container w-full">
        <div data-testid="wallet-card-face" data-revealed="true" className={styles.artworkFrame}>
          <iframe
            title={`${demo.name} Agent One card`}
            aria-hidden="true"
            tabIndex={-1}
            src={`/wallet/agent-one-card-${summary.cardId === "demo-0" ? "profile" : summary.cardId === "demo-1" ? "referral" : "nws"}.html?v=2`}
            className={styles.htmlArtwork}
          />
          <span aria-hidden="true" className={styles.artworkHitSurface} />
          {profileArtwork?.displayName ? <span className={styles.dynamicCardName}>{profileArtwork.displayName}</span> : null}
          {profileArtwork?.shareUrl ? <WalletCardQr value={profileArtwork.shareUrl} label="Wallet Profile QR code" className={styles.dynamicCardQr} /> : null}
        </div>
      </div>
    </div>
  );
}

export function WalletDemoCardDetails({ cardId, profile }: { cardId: string; profile?: WalletDemoProfile | null }) {
  const demo = demoFor(cardId);
  const summary = WALLET_DEMO_CARDS.find((card) => card.cardId === cardId);
  if (!demo || !summary) return null;
  const payload = profile?.cardPayload;
  const fields = [
    ["Name", profile?.displayName || payload?.full_name || null],
    ["Headline", payload?.headline || null],
    ["Organisation", payload?.organisation || null],
    ["Location", payload?.location_label || null],
    ["Summary", payload?.summary || null],
    ["Email", payload?.email || null],
    ["Phone", payload?.phone || null],
    ["Website", payload?.website || null],
    ["LinkedIn", payload?.linkedin || null],
    ["GitHub", payload?.github || null],
    ["Portfolio", payload?.portfolio || null],
  ].filter((field): field is [string, string] => Boolean(field[1]));
  return (
    <section aria-label="Wallet Profile details" aria-live="polite" className={styles.details} data-testid="wallet-demo-details">
      <div key={cardId} className="motion-step-enter space-y-4">
        <div className="space-y-1">
          <p className={TYPOGRAPHY_CLASSNAMES.helperText}>{demo.tier}</p>
          <h3 className={TYPOGRAPHY_CLASSNAMES.mediumRowLabel}>{demo.name} card</h3>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
          {fields.map(([label, value], index) => (
            <div key={label} className={index === 0 ? "col-span-2 min-w-0" : "min-w-0"}>
              <dt className={TYPOGRAPHY_CLASSNAMES.helperText}>{label}</dt>
              <dd className="mt-1 break-words text-sm font-medium tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {!fields.length ? <p className={TYPOGRAPHY_CLASSNAMES.helperText}>No saved Wallet Profile information is available.</p> : null}
      </div>
    </section>
  );
}

