"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2 } from "@/components/icons";
import { ProfilePaneScanIcon } from "@/components/profile/profile-pane-icons";
import { Button } from "@/components/ui/button";
import { isNative } from "@/lib/capacitor/platform";
import { CardScanError, pickNativeWalletCard, scanWalletCard } from "@/lib/services/wallet-card-scan";
import type { ScannedCardFields } from "@/lib/wallet/card-scan-fields";
import { useBackLayer } from "@/lib/navigation/back-layers";
import styles from "./secure-card-add-form.module.css";

export function WalletCardScanner({ active, disabled, backRoute, featured = false, onRead, onBusyChange }: {
  active: boolean; disabled: boolean;
  backRoute?: string;
  featured?: boolean;
  onRead: (fields: ScannedCardFields) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const capture = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const cancelScan = useCallback(() => {
    request.current?.abort(); request.current = null; setBusy(false); busyCallback.current(false);
  }, []);
  useBackLayer(backRoute ?? "", backRoute && active && busy ? 3 : 0, () => {
    cancelScan();
    return true;
  });
  useEffect(() => {
    if (!active) {
      request.current?.abort();
      request.current = null;
      setBusy(false);
      busyCallback.current(false);
      setNotice("");
    }
    return () => { request.current?.abort(); request.current = null; };
  }, [active]);
  const scan = async (acquire: () => Promise<Blob | null>) => {
    if (request.current || disabled || !active) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); onBusyChange(true); setNotice("");
    try {
      const file = await acquire();
      if (!file || controller.signal.aborted) return;
      const fields = await scanWalletCard(file, controller.signal);
      if (controller.signal.aborted) return;
      onRead(fields);
      setNotice("Details filled in. Check them, enter any missing details and CVV, then save your card.");
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof CardScanError ? error.message : "Card scanning is unavailable right now. Try again, or enter the details below.");
    } finally {
      if (request.current === controller) {
        request.current = null; setBusy(false); onBusyChange(false);
      }
    }
  };
  const choose = () => {
    if (request.current || disabled || !active) return;
    setNotice("");
    if (isNative()) void scan(() => pickNativeWalletCard("camera"));
    // Keep this synchronous with the tap so mobile browsers retain user activation.
    else capture.current?.click();
  };
  return <div className={styles.scanner} data-testid="wallet-card-scanner">
    <input ref={capture} type="file" accept="image/*" capture="environment" hidden
      aria-label="Take a card photo" disabled={disabled || busy || !active}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // Release the selected photo and allow a retry with the same image.
        event.currentTarget.value = "";
        if (file) void scan(async () => file);
      }} />
    {featured ? <div className={styles.scanIntro}>
      <button type="button" className={styles.scanArtwork} aria-label="Scan card"
        disabled={disabled || busy || !active} onClick={choose}>
        <Image src="/wallet/card-scan-agent-one.webp" alt="" width={768} height={644} unoptimized className={styles.scanReference} />
        <span className={styles.scanAffordance} aria-hidden="true"><ProfilePaneScanIcon />Scan here to add card</span>
      </button>
    </div> : <div className={styles.scanActions}>
      <Button type="button" variant="ghost" className={styles.scanAction} size="compact" disabled={disabled || busy || !active} onClick={choose}>
        <ProfilePaneScanIcon className={styles.fieldIcon} />Scan card
      </Button>
    </div>}
    {busy ? <div className={styles.scanProgress} role="status">
      <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      Reading on your device…
      <Button type="button" variant="ghost" size="compact" onClick={cancelScan}>Cancel scan</Button>
    </div> : null}
    {notice ? <p role="status" className={styles.scanHint}>{notice}</p> : null}
  </div>;
}
