"use client";

import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProfilePaneCardIcon, ProfilePaneCardNetworkIcon } from "@/components/profile/profile-pane-icons";
import { WalletService, type WalletNetworkContext } from "@/lib/services/wallet-service";
import type { CardBrand } from "@/lib/wallet/card-validation";
import styles from "./secure-card-add-form.module.css";

/** Suggestions contain catalog metadata only; no card credentials enter lookup. */
export function WalletCardProductFields({ context, network, country, active, bankName, cardProduct, onChange }: {
  context: WalletNetworkContext | null; network: CardBrand | ""; country: string; active: boolean;
  bankName: string; cardProduct: string; onChange: (bank: string, product: string) => void;
}) {
  const id = useId();
  const [choices, setChoices] = useState<{ key: string; banks: string[]; products: string[] } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const userId = context?.userId, vaultOwnerToken = context?.vaultOwnerToken;
  const key = JSON.stringify([context?.userId, context?.vaultOwnerToken, network, country, bankName, active]);
  useEffect(() => {
    const controller = new AbortController();
    setUnavailable(false);
    if (!userId || !vaultOwnerToken || !active || !network) return () => controller.abort();
    const timer = setTimeout(() => {
      void WalletService.cardProductChoices({ userId, vaultOwnerToken }, network, country || undefined, bankName, controller.signal).then(result => {
        if (!controller.signal.aborted) setChoices({ key, banks: [...new Set(result.banks.map(bank => bank.name))], products: [...new Set(result.variants.map(variant => variant.productName || variant.label))] });
      }).catch(() => { if (!controller.signal.aborted) { setChoices(null); setUnavailable(true); } });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [userId, vaultOwnerToken, network, country, bankName, active, key]);
  const visible = choices?.key === key ? choices : null;
  return <>
    <div className={styles.row}>
      <div className={styles.field}>
        <Label htmlFor={`${id}-bank`}><ProfilePaneCardNetworkIcon className={styles.fieldIcon} />Bank name</Label>
        <Input id={`${id}-bank`} list={`${id}-banks`} value={active ? bankName : ""} autoComplete="off" maxLength={100}
          placeholder="e.g. HDFC Bank" onChange={event => onChange(event.currentTarget.value, "")} data-voice-control-id="wallet-bank-name" />
        <datalist id={`${id}-banks`}>{visible?.banks.map(bank => <option key={bank} value={bank} />)}</datalist>
      </div>
      <div className={styles.field}>
        <Label htmlFor={`${id}-product`}><ProfilePaneCardIcon className={styles.fieldIcon} />Card product</Label>
        <Input id={`${id}-product`} list={`${id}-products`} value={active ? cardProduct : ""} autoComplete="off" maxLength={100}
          placeholder="e.g. Millennia" onChange={event => onChange(bankName, event.currentTarget.value)} data-voice-control-id="wallet-card-product" />
        <datalist id={`${id}-products`}>{visible?.products.map(product => <option key={product} value={product} />)}</datalist>
      </div>
    </div>
    <p role="status" className={styles.scanHint}>{unavailable
      ? "Card product suggestions are unavailable. You can still save your details with a neutral card."
      : "Enter the bank and exact product printed on your card. Matching catalog artwork is used when available; otherwise your card keeps a neutral design."}</p>
  </>;
}
