import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { formatCardExpiry, formatCardNumber } from "@/lib/wallet/wallet-card-presentation";
import styles from "./wallet-demo-cards.module.css";

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
export function WalletDemoCardFace({ summary }: { summary: WalletCardSummary }) {
  const demo = demoFor(summary.cardId);
  if (!demo) return <WalletCardFace summary={summary} collection />;
  return (
    <div className={`${styles.face} ${styles[demo.finish]}`} data-demo-card="true">
      <div className="@container w-full">
        <div data-testid="wallet-card-face" data-revealed="true" className={styles.artworkFrame}>
          <iframe
            title={`${demo.name} Agent One card`}
            src={`/wallet/agent-one-card-${summary.cardId === "demo-0" ? "profile" : summary.cardId === "demo-1" ? "referral" : "nws"}.html?v=2`}
            className={styles.htmlArtwork}
          />
        </div>
      </div>
    </div>
  );
}

export function WalletDemoCardDetails({ cardId }: { cardId: string }) {
  const demo = demoFor(cardId);
  const summary = WALLET_DEMO_CARDS.find((card) => card.cardId === cardId);
  if (!demo || !summary) return null;
  const fields = [
    ["Card number", formatCardNumber(summary.brand, demo.number)],
    ["Cardholder", "Alex Morgan"],
    ["Network", cardNetworkLabel(summary.brand)],
    ["Valid until", formatCardExpiry(summary.expiryMonth, summary.expiryYear)],
  ];
  return (
    <section aria-label="Example card details" aria-live="polite" className={styles.details} data-testid="wallet-demo-details">
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
        <p className={TYPOGRAPHY_CLASSNAMES.helperText}>These example details cannot be used for payments.</p>
      </div>
    </section>
  );
}




