"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Loader2 } from "@/components/icons";
import { ProfilePaneScanIcon } from "@/components/profile/profile-pane-icons";
import { Button } from "@/components/ui/button";
import { isNative } from "@/lib/capacitor/platform";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { pickNativeWalletCard, detectWalletCardRegion, scanWalletCardForReview, type CardScanDraft } from "@/lib/services/wallet-card-scan";
import { FULL_CARD, validCardCorners, validateCardImage, type CardCorners } from "@/lib/wallet/card-scan-image";
import { WalletLiveCardCapture } from "./wallet-live-card-capture";
import { WalletCardCrop } from "./wallet-card-crop";
import styles from "./secure-card-add-form.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";

/** Raw capture exists only in this mounted owner surface and is released on exit. */
export function WalletCardScanner({ active, disabled, backRoute, featured = false, showPhotoActions = true, compactControls = false, initialSource, onExit, onRead, onBusyChange }: {
  active: boolean; disabled: boolean; backRoute?: string; featured?: boolean; showPhotoActions?: boolean; compactControls?: boolean;
  initialSource?: "camera" | "photos"; onExit?: () => void;
  onRead: (draft: CardScanDraft) => void; onBusyChange: (busy: boolean) => void;
}) {
  const camera = useRef<HTMLInputElement>(null), gallery = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null), generation = useRef(0);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [live, setLive] = useState(false);
  const [photo, setPhoto] = useState<{ file: Blob; url: string } | null>(null);
  const [corners, setCorners] = useState<CardCorners>(FULL_CARD);
  const photoRef = useRef(photo); photoRef.current = photo;
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const clearCaptureResources = useCallback(() => {
    generation.current++; request.current?.abort(); request.current = null;
    if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
    photoRef.current = null;
  }, []);
  const release = () => {
    clearCaptureResources(); setPhoto(null); setLive(false); setBusy(false); busyCallback.current(false); onExit?.();
  };
  const pathname = usePathname();
  useBackLayer(backRoute ?? pathname, active && (photo || busy || live) ? 30 : 0, () => {
    if (!photoRef.current && !request.current && !live) return false;
    release(); setNotice(""); return true;
  });
  useEffect(() => {
    if (!active) { clearCaptureResources(); setPhoto(null); setLive(false); setBusy(false); busyCallback.current(false); setNotice(""); }
    return clearCaptureResources;
  }, [active, clearCaptureResources]);
  const acquire = async (get: (signal: AbortSignal) => Promise<Blob | null>) => {
    if (busy || disabled || !active) return;
    const version = ++generation.current; setNotice("");
    const controller = new AbortController(); request.current?.abort(); request.current = controller; setBusy(true); busyCallback.current(true);
    try {
      const file = await get(controller.signal);
      if (!file || version !== generation.current) return;
      await validateCardImage(file);
      if (version !== generation.current) return;
      if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
      const next = { file, url: URL.createObjectURL(file) }; photoRef.current = next; setPhoto(next);
      setCorners(FULL_CARD);
      const suggestion = await detectWalletCardRegion(file, controller.signal).catch(() => ({ corners: FULL_CARD, detected: false }));
      if (controller.signal.aborted || version !== generation.current) return;
      setCorners(suggestion.corners ?? FULL_CARD); busyCallback.current(true);
      if (suggestion.detected) setNotice("Card edges suggested. Adjust them if needed before reading.");
    } catch { if (version === generation.current && !controller.signal.aborted) setNotice("Camera or photo unavailable. Choose a JPG, PNG or WebP photo, or enter the details below."); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); busyCallback.current(Boolean(photoRef.current)); } }
  };
  const choose = (source: "camera" | "photos") => {
    if (isNative()) void acquire(signal => pickNativeWalletCard(source, signal));
    else if (source === "camera" && typeof navigator.mediaDevices?.getUserMedia === "function") { setLive(true); busyCallback.current(true); }
    else (source === "camera" ? camera : gallery).current?.click();
  };
  const launched = useRef(false);
  useEffect(() => {
    if (!active || !initialSource || launched.current) return;
    launched.current = true;
    choose(initialSource);
  }, [active, initialSource]);
  const scan = async () => {
    if (!photo || !validCardCorners(corners) || request.current || disabled || !active) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); busyCallback.current(true); setNotice("");
    try {
      // Add assigns catalog artwork when saving. Reading its fields must not
      // wait for a photo-artwork inspection that this form never consumes.
      const draft = await scanWalletCardForReview(photo.file, controller.signal, { corners });
      if (request.current !== controller || controller.signal.aborted) return;
      onRead(draft); release();
      setNotice(Object.keys(draft.fields).length ? "Review the recognized details below." : "Details were unclear. Retake the photo or enter them below.");
    } catch { if (!controller.signal.aborted) setNotice("This photo could not be read. Try another photo or enter your card details."); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); busyCallback.current(Boolean(photoRef.current)); } }
  };
  const fileInput = (ref: typeof camera, capture: boolean) => <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" capture={capture ? "environment" : undefined} hidden
    aria-label={capture ? "Take a card photo" : "Choose a card photo"} disabled={disabled || busy || !active}
    onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void acquire(async () => file); }} />;
  return <div className={styles.scanner} data-testid="wallet-card-scanner">
    {fileInput(camera, true)}{fileInput(gallery, false)}
    {live ? <WalletLiveCardCapture onCancel={release} onChoosePhoto={() => { release(); choose("photos"); }} onPhoto={file => { setLive(false); void acquire(async () => file); }} /> : !photo ? <>
      {featured ? <div className={styles.scanIntro}><button type="button" className={styles.scanArtwork} aria-label="Scan card" disabled={disabled || busy || !active} onClick={() => choose("camera")}>
        <span className={styles.scanVisual} aria-hidden="true">
          <Image src="/wallet/card-scan-complete-v4.webp" alt="" width={1536} height={1536} unoptimized className={styles.scanReference} />
        </span>
        <span className={styles.scanAffordance} aria-hidden="true"><ProfilePaneScanIcon />Scan to add card</span>
      </button></div> : null}
      {showPhotoActions || featured ? <div className={styles.scanActions}>
        {showPhotoActions ? <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={disabled || busy || !active} onClick={() => choose("camera")}>{compactControls ? "Scan card" : "Take photo"}</Button> : null}
        <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={disabled || busy || !active} onClick={() => choose("photos")}>Choose from photos</Button>
      </div> : null}
    </> : <section aria-label="Crop card photo" className="flex flex-col gap-3">
      <WalletCardCrop url={photo.url} corners={corners} disabled={busy} onChange={setCorners} />
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" size="compact" className={presentationStyles.quietAction} disabled={busy || !validCardCorners(corners)} onClick={() => void scan()}>Read card</Button>
        <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={busy} onClick={() => setCorners(FULL_CARD)}>Use full photo</Button>
        <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} onClick={release}>Cancel scan</Button>
      </div>
    </section>}
    {busy ? <div className={styles.scanProgress} role="status"><Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Reading on your device…{!photo && !live ? <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} onClick={release}>Cancel scan</Button> : null}</div> : null}
    {notice ? <p role="status" className={styles.scanHint}>{notice}</p> : null}
  </div>;
}
