"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, CameraIcon, Loader2 } from "@/components/icons";
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
export function WalletCardScanner({ active, disabled, backRoute, featured = false, showPhotoActions = true, compactControls = false, expandable = false, initialSource, onExit, onRead, onBusyChange }: {
  active: boolean; disabled: boolean; backRoute?: string; featured?: boolean; showPhotoActions?: boolean; compactControls?: boolean; expandable?: boolean;
  initialSource?: "camera" | "photos"; onExit?: () => void;
  onRead: (draft: CardScanDraft) => void; onBusyChange: (busy: boolean) => void;
}) {
  const panelId = useId(), nativePicking = useRef(false);
  const [expanded, setExpanded] = useState(false);
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
  const release = useCallback(() => {
    clearCaptureResources(); setPhoto(null); setLive(false); setExpanded(false); setBusy(false); busyCallback.current(false); onExit?.();
  }, [clearCaptureResources, onExit]);
  const pathname = usePathname();
  useBackLayer(backRoute ?? pathname, active && (photo || busy || live || expanded) ? 30 : 0, () => {
    if (!photoRef.current && !request.current && !live && !expanded) return false;
    release(); setNotice(""); return true;
  });
  useEffect(() => {
    if (!active) { clearCaptureResources(); setPhoto(null); setLive(false); setExpanded(false); setBusy(false); busyCallback.current(false); setNotice(""); }
    return clearCaptureResources;
  }, [active, clearCaptureResources]);
  useEffect(() => {
    if (!expandable || !expanded) return;
    const hide = () => { if (document.visibilityState === "hidden" && !nativePicking.current) release(); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [expandable, expanded, release]);
  const acquire = useCallback(async (get: (signal: AbortSignal) => Promise<Blob | null>) => {
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
  }, [busy, disabled, active]);
  const choose = useCallback((source: "camera" | "photos") => {
    if (expandable) { setExpanded(true); busyCallback.current(true); }
    if (isNative()) void acquire(async signal => { nativePicking.current = true; try { return await pickNativeWalletCard(source, signal); } finally { nativePicking.current = false; } });
    else if (source === "camera" && typeof navigator.mediaDevices?.getUserMedia === "function") { setLive(true); busyCallback.current(true); }
    else (source === "camera" ? camera : gallery).current?.click();
  }, [acquire, expandable]);
  const launched = useRef(false);
  useEffect(() => {
    if (!active || !initialSource || launched.current) return;
    launched.current = true;
    choose(initialSource);
  }, [active, initialSource, choose]);
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
  const openCapture = () => { setExpanded(true); setNotice(""); busyCallback.current(true); };
  const controls = <div className={styles.scanActions}>
    <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={disabled || busy || !active} onClick={() => choose("photos")}>Choose from photos</Button>
    <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={disabled || busy || !active} aria-expanded={expanded} aria-controls={panelId} onClick={openCapture}><CameraIcon aria-hidden="true" className="size-4" />Take photo</Button>
  </div>;
  return <div className={styles.scanner} data-testid="wallet-card-scanner">
    {fileInput(camera, true)}{fileInput(gallery, false)}
    {expandable && !expanded ? controls : null}
    {expandable && expanded ? <div className={styles.scanStepHeader}>
      <p id={`${panelId}-title`}>Scan card</p>
      <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} onClick={() => { release(); setNotice(""); }}>Close scanner</Button>
    </div> : null}
    <div id={panelId} role={expandable && expanded ? "region" : undefined} aria-labelledby={expandable && expanded ? `${panelId}-title` : undefined} hidden={expandable && !expanded} className={expandable && expanded ? styles.scanPanel : undefined}>
    {live ? <WalletLiveCardCapture onCancel={release} onChoosePhoto={() => { setLive(false); choose("photos"); }} onPhoto={file => { setLive(false); void acquire(async () => file); }} /> : !photo ? <>
      {(featured || expandable) ? <div className={styles.scanIntro}><button type="button" className={styles.scanArtwork} aria-label="Scan card" disabled={disabled || busy || !active} onClick={() => choose("camera")}>
        <span className={styles.scanVisual} aria-hidden="true">
          <svg viewBox="0 0 280 180" fill="none" className={styles.scanCardOutline}>
            <path d="M24 48V28a8 8 0 0 1 8-8h20m176 0h20a8 8 0 0 1 8 8v20M24 132v20a8 8 0 0 0 8 8h20m176 0h20a8 8 0 0 0 8-8v-20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <rect x="44" y="38" width="192" height="104" rx="12" className={styles.scanCardBody} />
            <rect x="62" y="58" width="26" height="20" rx="4" className={styles.scanCardChip} />
            <path d="M62 103h22m12 0h22m12 0h22m12 0h22M62 122h58" className={styles.scanCardDetails} strokeWidth="4" strokeLinecap="round" />
          </svg>
        </span>
        <span className={styles.scanAffordance} aria-hidden="true"><CameraIcon />Scan card</span>
        <span className={styles.scanDescription} aria-hidden="true">Take a clear photo of your card to fill in the details.</span>
      </button></div> : null}
      {expandable ? <div className={styles.scanActions}><Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={disabled || busy || !active} onClick={() => choose("photos")}>Choose from photos</Button></div> : showPhotoActions || featured ? <div className={styles.scanActions}>
        {showPhotoActions ? <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={disabled || busy || !active} onClick={() => choose("camera")}>{compactControls ? "Scan card" : "Take photo"}</Button> : null}
        <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={disabled || busy || !active} onClick={() => choose("photos")}>Choose from photos</Button>
      </div> : null}
    </> : <section aria-label="Crop card photo" className="flex flex-col gap-3">
      <WalletCardCrop url={photo.url} corners={corners} disabled={busy} onChange={setCorners} />
      <div className="flex justify-end pt-2">
        <Button type="button" size="prominent" className="w-full gap-2 sm:w-auto sm:min-w-[160px]" isLoading={busy}
          disabled={disabled || !active || busy || !validCardCorners(corners)} onClick={() => void scan()}>
          Next<ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </section>}
    </div>
    {busy ? <div className={styles.scanProgress} role="status"><Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Reading on your device…</div> : null}
    {notice ? <p role="status" className={styles.scanHint}>{notice}</p> : null}
  </div>;
}
