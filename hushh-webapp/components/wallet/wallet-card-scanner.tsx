"use client";

import { useEffect, useRef, useState } from "react";
import { CreditCard, ImageIcon, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { isNative } from "@/lib/capacitor/platform";
import { pickNativeWalletCard, scanWalletCard } from "@/lib/services/wallet-card-scan";
import type { ScannedCardFields } from "@/lib/wallet/card-scan-fields";
import styles from "./secure-card-add-form.module.css";

export function WalletCardScanner({ active, disabled, onRead, onBusyChange }: {
  active: boolean; disabled: boolean;
  onRead: (fields: ScannedCardFields) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
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
      setNotice("Details filled in. Check every field before saving.");
    } catch {
      if (!controller.signal.aborted) setNotice("We couldn't read the card. Use a clear JPG, PNG or WebP photo under 15 MB, or enter the details below.");
    } finally {
      if (request.current === controller) {
        request.current = null; setBusy(false); onBusyChange(false);
      }
    }
  };
  const choose = (source: "camera" | "photos") => {
    if (isNative()) void scan(() => pickNativeWalletCard(source));
    else (source === "camera" ? camera : photos).current?.click();
  };
  return <div className={styles.scanner} data-testid="wallet-card-scanner">
    <div className={styles.scanActions}>
      <Button variant="secondary" size="standard" disabled={disabled || busy || !active} onClick={() => choose("camera")}>
        <CreditCard aria-hidden="true" />Scan card
      </Button>
      <Button variant="ghost" size="standard" disabled={disabled || busy || !active} onClick={() => choose("photos")}>
        <ImageIcon aria-hidden="true" />Choose photo
      </Button>
    </div>
    {(["camera", "photos"] as const).map((source) => <input key={source}
      ref={source === "camera" ? camera : photos} type="file" hidden
      accept="image/jpeg,image/png,image/webp" capture={source === "camera" ? "environment" : undefined}
      data-testid={`wallet-scan-${source}`}
      onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) void scan(async () => file);
      }} />)}
    {busy ? <div className={styles.scanProgress} role="status">
      <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      Reading on your device…
      <Button variant="ghost" size="compact" onClick={() => {
        request.current?.abort(); request.current = null; setBusy(false); onBusyChange(false);
      }}>Cancel scan</Button>
    </div> : <p className={styles.scanHint}>Your photo stays on this device. Nothing is saved until you choose Save card.</p>}
    {notice ? <p role="status" className={styles.scanHint}>{notice}</p> : null}
  </div>;
}
