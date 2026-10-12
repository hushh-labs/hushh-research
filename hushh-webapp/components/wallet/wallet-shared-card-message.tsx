"use client";
import { useEffect, useRef, useState } from "react";
import { Lock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { WalletCardFace } from "./wallet-card-face";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { OneLocationService } from "@/lib/one-location/service";
import { openWalletCardShare, type SharedPaymentCard } from "@/lib/wallet/wallet-card-share";
import { morphyToast } from "@/lib/morphy-ux/morphy";

export function WalletSharedCardMessage({ content, peerPersonRef, senderIsViewer }: {
  content: string; peerPersonRef: string | null; senderIsViewer: boolean;
}) {
  const { user } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const [card, setCard] = useState<{ revision: number; value: SharedPaymentCard } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const scope = useRef({ userId: user?.uid, vaultKey, content, peerPersonRef, senderIsViewer, revision: 0 });
  const current = scope.current;
  if (current.userId !== user?.uid || current.vaultKey !== vaultKey || current.content !== content || current.peerPersonRef !== peerPersonRef || current.senderIsViewer !== senderIsViewer) {
    scope.current = { userId: user?.uid, vaultKey, content, peerPersonRef, senderIsViewer, revision: current.revision + 1 };
  }
  const tokenGetter = useRef(getVaultOwnerToken);
  tokenGetter.current = getVaultOwnerToken;
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") { scope.current.revision += 1; setCard(null); setBusy(false); } };
    document.addEventListener("visibilitychange", hide);
    return () => { scope.current.revision += 1; document.removeEventListener("visibilitychange", hide); };
  }, []);
  useEffect(() => { setCard(null); setBusy(false); }, [vaultKey, user?.uid, content, peerPersonRef, senderIsViewer]);
  const shown = card?.revision === scope.current.revision ? card.value : null;
  const view = async () => {
    if (!vaultKey) { setUnlock(true); return; }
    const token = tokenGetter.current();
    const uid = user?.uid;
    if (!uid || !token || !peerPersonRef || busy) return;
    const revision = scope.current.revision;
    const isCurrent = () => scope.current.revision === revision && tokenGetter.current() === token && document.visibilityState !== "hidden";
    setBusy(true);
    try {
      // Resolve the peer from the authenticated conversation reference, never
      // from the untrusted encrypted message body.
      let peerId: string | undefined;
      for (let page = 1; ; page += 1) {
        const result = await OneLocationService.listRecipientsPage({ vaultOwnerToken: token, page, limit: 50 });
        if (!isCurrent()) return;
        peerId = result.items.find(item => item.publicPersonRef === peerPersonRef)?.userId;
        if (peerId || !result.hasMore) break;
        if (result.page !== page || !result.items.length) throw new Error("Peer unavailable.");
      }
      if (!peerId) throw new Error("Peer unavailable.");
      const state = await OneLocationService.getState(token);
      if (!isCurrent()) return;
      const value = await openWalletCardShare({ content, userId: uid, peerUserId: peerId, senderIsViewer,
        recovery: state.myRecipientKey ? { vaultKey, remoteBackup: state.myRecipientKey } : undefined });
      if (isCurrent()) setCard({ revision, value });
    } catch { if (isCurrent()) morphyToast.error("Card unavailable. Ask the sender to share it again."); }
    finally { if (isCurrent()) setBusy(false); }
  };
  return <section aria-label="Shared payment card" className="space-y-3 text-sm">
    <p className="flex items-center gap-2"><Lock aria-hidden="true" className="size-4" />Shared payment card</p>
    {shown ? <>
      <WalletCardFace summary={{ cardId: "shared-card", nickname: "", brand: shown.brand, last4: shown.pan.slice(-4), expiryMonth: shown.expiryMonth, expiryYear: shown.expiryYear, issuingRegion: shown.issuingRegion, createdAt: "" }} revealed={{ pan: shown.pan, cardholderName: shown.cardholderName }} />
      <Button variant="secondary" size="compact" onClick={() => { scope.current.revision += 1; setCard(null); }}>Hide card</Button>
    </> : <Button variant="secondary" size="compact" disabled={busy} onClick={() => void view()}>{busy ? "Opening…" : vaultKey ? "View card details" : "Unlock to view card"}</Button>}
    {user ? <VaultUnlockDialog user={user} onSuccess={() => setUnlock(false)} open={unlock} onOpenChange={setUnlock} title="Unlock to view the card" description="Card details open only on your device." /> : null}
  </section>;
}
