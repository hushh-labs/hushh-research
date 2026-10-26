"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Button } from "@/components/ui/button";
import { OneLocationService } from "@/lib/one-location/service";
import { openWalletCardShare, type SharedPaymentCard } from "@/lib/wallet/wallet-card-share";
import type { CardAccessView } from "@/lib/services/wallet-card-access-service";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { WalletCardFace } from "./wallet-card-face";
import presentationStyles from "./wallet-connect-presentation.module.css";

/** Mounted only while the server-authorized grant is active. No decrypted persistence. */
export function WalletAccessCardDetails({ grantId, data }: { grantId: string; data: CardAccessView }) {
  const { user } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const [unlock, setUnlock] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState<{ scope: string; key: string; card: SharedPaymentCard } | null>(null);
  // Polling can return the same metadata in a different JSON property order.
  // Only changed values invalidate the in-memory reveal.
  const scope = JSON.stringify([user?.uid, grantId, data.encryptedCard, data.senderUserId,
    data.card?.brand, data.card?.last4, data.card?.expiryMonth, data.card?.expiryYear, data.card?.issuingRegion]);
  const current = useRef({ scope, vaultKey });
  current.current = { scope, vaultKey };
  const tokenGetter = useRef(getVaultOwnerToken);
  tokenGetter.current = getVaultOwnerToken;
  useEffect(() => {
    let cancelled = false;
    setOpened(null); setFailed(false);
    if (!data.encryptedCard || !data.senderUserId || !user?.uid || !vaultKey) return;
    const isCurrent = () => !cancelled && current.current.scope === scope && current.current.vaultKey === vaultKey && document.visibilityState !== "hidden";
    void (async () => {
      try {
        const token = tokenGetter.current();
        if (!token) throw new Error("Wallet locked");
        const state = await OneLocationService.getState(token);
        if (!isCurrent()) return;
        const card = await openWalletCardShare({ content: data.encryptedCard!, userId: user.uid,
          peerUserId: data.senderUserId!, senderIsViewer: false,
          recovery: state.myRecipientKey ? { vaultKey, remoteBackup: state.myRecipientKey } : undefined });
        if (!isCurrent()) return;
        if (card.pan.slice(-4) !== data.card?.last4 || card.brand !== data.card.brand || card.expiryMonth !== data.card.expiryMonth || card.expiryYear !== data.card.expiryYear) throw new Error("Card changed");
        setOpened({ scope, key: vaultKey, card });
      } catch { if (isCurrent()) setFailed(true); }
    })();
    return () => { cancelled = true; };
  }, [scope, vaultKey, user?.uid, data.encryptedCard, data.senderUserId, data.card?.last4, data.card?.brand, data.card?.expiryMonth, data.card?.expiryYear]);
  const shown = opened?.scope === scope && opened.key === vaultKey ? opened.card : null;
  if (!data.card) return null;
  return <div className={`${presentationStyles.walletSurface} space-y-2`}>
    <WalletCardFace summary={{ cardId: grantId, nickname: "Shared card", brand: data.card.brand as WalletCardSummary["brand"],
      last4: data.card.last4, expiryMonth: data.card.expiryMonth, expiryYear: data.card.expiryYear, issuingRegion: data.card.issuingRegion, createdAt: "" }}
      revealed={shown ? { pan: shown.pan, cardholderName: shown.cardholderName } : null} />
    {data.encryptedCard && !vaultKey ? <Button variant="secondary" size="standard" onClick={() => setUnlock(true)}>Unlock to view card number</Button> : null}
    {data.encryptedCard && vaultKey && !shown && !failed ? <p role="status" className="text-[13px] leading-[18px]">Opening encrypted card…</p> : null}
    {failed ? <p role="alert" className="text-[13px] leading-[18px] text-destructive">Could not open the card number. Ask the sender to share again.</p> : null}
    {!data.encryptedCard ? <p className="mt-2 text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">This share includes only the last four digits. Ask the sender to share again for the full number.</p> : null}
    {user ? <VaultUnlockDialog user={user} open={unlock} onOpenChange={setUnlock} onSuccess={() => setUnlock(false)} title="Unlock to view card number" description="Card details open only on your device." /> : null}
  </div>;
}
