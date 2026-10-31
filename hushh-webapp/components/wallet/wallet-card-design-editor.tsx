"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { WalletService, type WalletCardSummary, type WalletNetworkInput } from "@/lib/services/wallet-service";
import type { WalletCardArtwork } from "@/lib/wallet/card-artwork";
import type { CardScanDraft } from "@/lib/services/wallet-card-scan";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { WalletCardFace } from "./wallet-card-face";
import { WalletCardScanner } from "./wallet-card-scanner";
import { WalletCardArtworkPicker } from "./wallet-card-artwork-picker";
import { useWalletArtworkVisibility } from "@/lib/wallet/use-wallet-artwork-visibility";

interface OwnerContext { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent: () => boolean }
export function WalletCardDesignEditor({ card, name, getContext, onSaved }: {
  card: WalletCardSummary; name?: string; getContext: () => OwnerContext | null; onSaved: (artwork: WalletCardArtwork) => void;
}) {
  const [open, setOpen] = useState(false), [input, setInput] = useState<WalletNetworkInput | null>(null);
  const [artwork, setArtwork] = useState<WalletCardArtwork | undefined>();
  const [saveBusy, setSaveBusy] = useState(false);
  const [reading, setReading] = useState<CardScanDraft | null>(null), [busy, setBusy] = useState(false), [scanning, setScanning] = useState(false), [notice, setNotice] = useState("");
  const revision = useRef(0), saving = useRef(false), pathname = usePathname();
  const close = () => { revision.current++; setOpen(false); setInput(null); setArtwork(undefined); setReading(null); };
  useEffect(() => () => { revision.current++; }, []);
  useBackLayer(pathname, open ? 20 : 0, () => { if (!open) return false; close(); return true; });
  const begin = async () => {
    const context = getContext(); if (!context) return;
    const version = ++revision.current; setOpen(true); setNotice(""); setInput(null); setArtwork(undefined); setReading(null);
    try { const value = await WalletService.cardArtworkLookupInput({ ...context, cardId: card.cardId }); if (context.isCurrent() && version === revision.current) setInput(value); }
    catch { if (version === revision.current) setNotice("Original artwork unavailable. A neutral design is ready."); }
  };
  const context = open ? getContext() : null;
  const artworkVisible = useWalletArtworkVisibility(context, artwork?.source === "catalog" ? artwork : undefined, Boolean(context));
  if (!open) return <Button type="button" variant="ghost" size="compact" onClick={() => void begin()}>Change card design</Button>;
  return <section aria-label="Change card design" className="space-y-4">
    <WalletCardFace summary={card} cardholderName={name} artwork={artworkVisible ? artwork : undefined} />
    <WalletCardScanner active={Boolean(context)} disabled={saveBusy} onBusyChange={setScanning} onRead={draft => { setArtwork(undefined); setReading({ fields: {}, states: { pan: "missing", expiry: "missing", cardholderName: "missing" }, sanitized: draft.sanitized, candidate: draft.candidate }); }} />
    <WalletCardArtworkPicker context={context} prefix={input?.iinPrefix ?? ""} panLength={input?.panLength ?? 0} active={Boolean(context) && !scanning && !saveBusy} sanitized={reading?.sanitized} candidate={reading?.candidate} value={artwork} onChange={setArtwork} onBusyChange={setBusy} />
    <div className="flex justify-center gap-2"><Button type="button" size="compact" disabled={!artwork || busy || scanning || saveBusy || !context} onClick={() => {
      const owner = getContext(); if (!owner || !artwork || saving.current) return;
      const value = artwork, version = revision.current; saving.current = true; setSaveBusy(true); setBusy(true);
      void WalletService.updateCardArtwork({ ...owner, cardId: card.cardId, artwork: value, isCurrent: () => owner.isCurrent() && version === revision.current }).then(() => {
        if (owner.isCurrent() && version === revision.current) { onSaved(value); close(); }
      }).catch(() => { if (version === revision.current) setNotice("Design could not be saved. Try again."); })
        .finally(() => { saving.current = false; setSaveBusy(false); setBusy(false); });
    }}>Save design</Button><Button type="button" variant="ghost" size="compact" onClick={close}>Cancel</Button></div>
    {notice ? <p role="status" className={TYPOGRAPHY_CLASSNAMES.helperText}>{notice}</p> : null}
  </section>;
}
