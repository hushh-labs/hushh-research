"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { cardNetworkLabel } from "./card-network-mark";
import { WalletCardFace } from "./wallet-card-face";
import { openEncryptedCardFile, readEncryptedCardFile, type EncryptedCardFile } from "@/lib/wallet/wallet-card-file";
import type { SharedPaymentCard } from "@/lib/wallet/shared-payment-card";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import styles from "./wallet-encrypted-card-viewer.module.css";

/** Anonymous reader: chosen files and passwords stay in component memory. */
export function WalletEncryptedCardViewer() {
  const [envelope, setEnvelope] = useState<EncryptedCardFile | null>(null);
  const [password, setPassword] = useState("");
  const [card, setCard] = useState<SharedPaymentCard | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const invalidate = () => { revision.current += 1; setCard(null); setBusy(false); };
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") { revision.current += 1; setCard(null); setPassword(""); setBusy(false); setReading(false); }
    };
    document.addEventListener("visibilitychange", hide);
    return () => { revision.current += 1; document.removeEventListener("visibilitychange", hide); };
  }, []);

  const choose = async (file?: File) => {
    invalidate(); setPassword(""); setEnvelope(null); setReading(Boolean(file));
    const request = revision.current;
    if (!file) return;
    try {
      const value = await readEncryptedCardFile(file);
      if (revision.current === request) setEnvelope(value);
    } catch { if (revision.current === request) morphyToast.error("Choose a valid encrypted card file."); }
    finally { if (revision.current === request) setReading(false); }
  };
  const open = async () => {
    if (!envelope || !password || busy) return;
    const request = revision.current;
    setBusy(true);
    try {
      const value = await openEncryptedCardFile(envelope, password);
      if (revision.current === request && document.visibilityState !== "hidden") { setCard(value); setPassword(""); }
    } catch { if (revision.current === request) morphyToast.error("Could not open this card. Check the file and password."); }
    finally { if (revision.current === request) setBusy(false); }
  };

  return <AppPageShell width="reading" className="py-6">
    <section className={`${styles.reader} mx-auto w-full max-w-[820px] space-y-5 font-[family-name:var(--font-app-body)]`} aria-label="Open encrypted card">
      <header className="space-y-2"><h1 className="text-lg font-semibold">Open encrypted card</h1><p className="text-xs text-muted-foreground">Choose the file and enter its password. No account needed.</p></header>
      {card ? <>
        <div className="mx-auto w-full max-w-[420px]"><WalletCardFace summary={{ cardId: "shared-card", nickname: "", brand: card.brand, last4: card.pan.slice(-4), expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, issuingRegion: card.issuingRegion, createdAt: "" }} revealed={{ pan: card.pan, cardholderName: card.cardholderName }} /></div>
        <SettingsPresentationProvider separatorInset density="compact"><section className={profileStyles.walletContent} aria-label="Shared card details"><SettingsGroup title="Card details">
          <SettingsRow title="Card number" stackTrailingOnMobile trailing={<span className={styles.value}>{card.pan.replace(/(.{4})(?=.)/g, "$1 ")}</span>} />
          <SettingsRow title="Name on card" stackTrailingOnMobile trailing={<span className={styles.value}>{card.cardholderName}</span>} />
          <SettingsRow title="Card network" trailing={cardNetworkLabel(card.brand)} />
          <SettingsRow title="Expiry (MM/YY)" trailing={`${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}`} />
          <SettingsRow title="Issuing region" trailing={card.issuingRegion} />
        </SettingsGroup></section></SettingsPresentationProvider>
        <Button variant="secondary" size="compact" onClick={() => { invalidate(); setPassword(""); }}>Hide card</Button>
      </> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); void open(); }}>
        <div className="space-y-2"><label className="text-[13px] font-medium" htmlFor="encrypted-card-file">Encrypted card file</label><Input id="encrypted-card-file" type="file" accept=".json,application/json" className="text-xs" onChange={event => void choose(event.target.files?.[0])} /></div>
        <div className="space-y-2"><label className="text-[13px] font-medium" htmlFor="encrypted-card-password">Password</label><Input id="encrypted-card-password" type="password" autoComplete="off" value={password} disabled={reading} className="text-xs" onChange={event => { invalidate(); setPassword(event.target.value); }} /></div>
        <Button type="submit" size="compact" disabled={!envelope || !password || reading || busy}>{reading ? "Reading file…" : busy ? "Opening…" : "Open card"}</Button>
        <p className="text-xs text-muted-foreground">The file opens on this device. It is never uploaded.</p>
      </form>}
    </section>
  </AppPageShell>;
}
