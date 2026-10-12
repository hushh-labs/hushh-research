"use client";

import { WalletProfileCard } from "./wallet-profile-card";
import { walletProfilePresentation } from "@/components/wallet-card/wallet-profile-presentation";

/** The owner previews the same approved profile projection as the Wallet face. */
export function WalletCardPassPreview({ fullName, headline, organisation, locationLabel, email, phone, avatarUrl, shareUrl, className }: {
  fullName: string; headline: string; organisation: string; locationLabel: string;
  email?: string; phone?: string; avatarUrl?: string | null;
  shareUrl: string | null; className?: string;
}) {
  return <div data-testid="wallet-card-pass-preview" className={className}>
    <WalletProfileCard profile={walletProfilePresentation({
      cardPayload: { full_name: fullName, headline, organisation, location_label: locationLabel, email, phone },
      avatarUrl, shareUrl,
    })} />
  </div>;
}
