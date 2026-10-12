"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";
import { ProfilePaneScanIcon } from "@/components/profile/profile-pane-icons";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isNative } from "@/lib/capacitor/platform";
import { CardScanError, pickNativeWalletCard, scanWalletCard } from "@/lib/services/wallet-card-scan";
import type { ScannedCardFields } from "@/lib/wallet/card-scan-fields";
import styles from "./secure-card-add-form.module.css";

export function WalletCardScanner({ active, disabled, onRead, onBusyChange }: {
  active: boolean; disabled: boolean;
  onRead: (fields: ScannedCardFields) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  useEffect(() => {
    if (!cameraOpen || !active) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    setCameraReady(false); setCameraError("");
    const stop = () => stream?.getTracks().forEach(track => track.stop());
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        if (cancelled) { stop(); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
      } catch {
        stop();
        if (!cancelled) setCameraError("Camera unavailable. Allow camera access in your browser, or enter your card details manually.");
      }
    };
    void start();
    const hide = () => { if (document.visibilityState === "hidden") { cancelled = true; stop(); setCameraOpen(false); } };
    document.addEventListener("visibilitychange", hide);
    return () => { cancelled = true; stop(); document.removeEventListener("visibilitychange", hide); };
  }, [cameraOpen, active]);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    if (!active) {
      setCameraOpen(false);
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
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof CardScanError ? error.message : "Card scanning is unavailable right now. Try again, or enter the details below.");
    } finally {
      if (request.current === controller) {
        request.current = null; setBusy(false); onBusyChange(false);
      }
    }
  };
  const choose = () => {
    if (isNative()) void scan(() => pickNativeWalletCard("camera"));
    else setCameraOpen(true);
  };
  return <div className={styles.scanner} data-testid="wallet-card-scanner">
    <div className={styles.scanActions}>
      <Button type="button" variant="ghost" className={styles.scanAction} size="compact" disabled={disabled || busy || !active} onClick={choose}>
        <ProfilePaneScanIcon className={styles.fieldIcon} />Scan card
      </Button>
    </div>
    <Dialog modal open={cameraOpen && active} onOpenChange={setCameraOpen}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Scan card</DialogTitle>
        <DialogDescription>Place your card inside the camera view. Details are read on your device.</DialogDescription>
        <video ref={video} autoPlay muted playsInline className="aspect-[1.586] w-full rounded-xl bg-black object-contain" aria-label="Card camera preview" onLoadedData={() => setCameraReady(true)} />
        {cameraError ? <p role="alert">{cameraError}</p> : null}
        <Button type="button" disabled={!cameraReady || Boolean(cameraError) || busy} onClick={() => {
          const source = video.current;
          if (!source?.videoWidth || !source.videoHeight) return;
          const canvas = document.createElement("canvas");
          canvas.width = source.videoWidth; canvas.height = source.videoHeight;
          const context = canvas.getContext("2d");
          if (!context) return;
          context.drawImage(source, 0, 0);
          setCameraOpen(false);
          void scan(() => new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .95)));
        }}>Capture card</Button>
        <Button type="button" variant="ghost" onClick={() => setCameraOpen(false)}>Cancel</Button>
      </DialogContent>
    </Dialog>
    {busy ? <div className={styles.scanProgress} role="status">
      <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      Reading on your device…
      <Button type="button" variant="ghost" size="compact" onClick={() => {
        request.current?.abort(); request.current = null; setBusy(false); onBusyChange(false);
      }}>Cancel scan</Button>
    </div> : null}
    {notice ? <p role="status" className={styles.scanHint}>{notice}</p> : null}
  </div>;
}
