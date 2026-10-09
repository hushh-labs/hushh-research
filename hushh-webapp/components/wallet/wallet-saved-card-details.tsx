import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { cardNetworkLabel } from "./card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";

export function WalletSavedCardDetails({ card, name }: { card: WalletCardSummary; name?: string }) {
  const rows = [
    ["Card number", `•••• •••• •••• ${card.last4}`],
    ["Name on card", name || "Not provided"],
    ["Card network", cardNetworkLabel(card.brand)],
    ["Expiry (MM/YY)", `${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}`],
    ["CVV", "Hidden"],
    ["PIN (optional)", "Hidden if saved"],
    ["Issuing region", card.issuingRegion || "Not provided"],
  ];
  return <SettingsPresentationProvider separatorInset density="compact">
    <section aria-label="Saved card details" className={`${profileStyles.walletContent} space-y-4`}>
      <SettingsGroup title="Card details">
        {rows.map(([label, value]) => <SettingsRow key={label} density="compact" title={label} trailing={<span className="min-w-0 break-words text-right">{value}</span>} />)}
      </SettingsGroup>
    </section>
  </SettingsPresentationProvider>;
}
