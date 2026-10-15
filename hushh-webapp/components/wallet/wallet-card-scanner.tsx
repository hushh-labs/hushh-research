"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Loader2 } from "@/components/icons";
import { ProfilePaneScanIcon } from "@/components/profile/profile-pane-icons";
import { Button } from "@/components/ui/button";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { isNative } from "@/lib/capacitor/platform";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { pickNativeWalletCard, detectWalletCardRegion, scanWalletCardForReview, type CardScanDraft } from "@/lib/services/wallet-card-scan";
import { FULL_CARD, validCardCorners, validateCardImage, type CardCorners } from "@/lib/wallet/card-scan-image";
import { WalletLiveCardCapture } from "./wallet-live-card-capture";
import styles from "./secure-card-add-form.module.css";

/** Raw capture exists only in this mounted owner surface and is released on exit. */
export function WalletCardScanner({ active, disabled, featured = false, showPhotoActions = true, onRead, onBusyChange }: {
  active: boolean; disabled: boolean; featured?: boolean; showPhotoActions?: boolean;
  onRead: (draft: CardScanDraft) => void; onBusyChange: (busy: boolean) => void;
}) {
  const camera = useRef<HTMLInputElement>(null), gallery = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null), generation = useRef(0);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [live, setLive] = useState(false);
  const [photo, setPhoto] = useState<{ file: Blob; url: string } | null>(null);
  const [corners, setCorners] = useState<CardCorners>(FULL_CARD), [cornerIndex, setCornerIndex] = useState(0);
  const photoRef = useRef(photo); photoRef.current = photo;
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const clearCaptureResources = useCallback(() => {
    generation.current++; request.current?.abort(); request.current = null;
    if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
    photoRef.current = null;
  }, []);
  const release = () => {
    clearCaptureResources(); setPhoto(null); setLive(false); setBusy(false); busyCallback.current(false);
  };
  const pathname = usePathname();
  useBackLayer(pathname, active && (photo || busy || live) ? 30 : 0, () => {
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
      const suggestion = await detectWalletCardRegion(file, controller.signal).catch(() => ({ corners: FULL_CARD, detected: false }));
      if (controller.signal.aborted || version !== generation.current) return;
      setCorners(suggestion.corners ?? FULL_CARD); setCornerIndex(0); busyCallback.current(true);
      if (suggestion.detected) setNotice("Card edges suggested. Adjust them if needed before reading.");
    } catch { if (version === generation.current && !controller.signal.aborted) setNotice("Camera or photo unavailable. Choose a JPG, PNG or WebP photo, or enter the details below."); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); busyCallback.current(Boolean(photoRef.current)); } }
  };
  const choose = (source: "camera" | "photos") => {
    if (isNative()) void acquire(signal => pickNativeWalletCard(source, signal));
    else if (source === "camera" && typeof navigator.mediaDevices?.getUserMedia === "function") { setLive(true); busyCallback.current(true); }
    else (source === "camera" ? camera : gallery).current?.click();
  };
  const scan = async () => {
    if (!photo || !validCardCorners(corners) || request.current || disabled || !active) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); busyCallback.current(true); setNotice("");
    try {
      const draft = await scanWalletCardForReview(photo.file, controller.signal, { corners, artwork: true });
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
    {live ? <WalletLiveCardCapture onCancel={release} onPhoto={file => { setLive(false); void acquire(async () => file); }} /> : !photo ? <>
      {featured ? <div className={styles.scanIntro}><button type="button" className={styles.scanArtwork} aria-label="Scan card" disabled={disabled || busy || !active} onClick={() => choose("camera")}>
        <Image src="/wallet/card-scan-agent-one.webp" alt="" width={768} height={644} unoptimized className={styles.scanReference} />
        <span className={styles.scanAffordance} aria-hidden="true"><ProfilePaneScanIcon />Scan here to add card</span>
      </button></div> : null}
      {showPhotoActions ? <div className={styles.scanActions}>
        <Button type="button" variant="ghost" size="compact" disabled={disabled || busy || !active} onClick={() => choose("camera")}>Take photo</Button>
        <Button type="button" variant="ghost" size="compact" disabled={disabled || busy || !active} onClick={() => choose("photos")}>Choose from photos</Button>
      </div> : null}
    </> : <section aria-label="Crop card photo" className="flex flex-col gap-3">
      <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Tap the four card corners clockwise, starting at the top left.</p>
      <button type="button" aria-label={`Set card corner ${cornerIndex + 1}`} disabled={busy} className="relative block min-h-11 w-full overflow-hidden rounded-2xl" onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const next = [...corners] as CardCorners; next[cornerIndex] = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
        setCorners(next); setCornerIndex((cornerIndex + 1) % 4);
      }}>
        {/* Owner-local blob URL is deliberately not sent through Next image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.url} alt="Your unsaved card photo" className="block h-auto w-full" />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <polygon points={corners.map(p => `${p.x * 100},${p.y * 100}`).join(" ")} fill="none" stroke="var(--app-accent)" strokeWidth=".6" />
          {corners.map((p, i) => <circle key={i} cx={p.x * 100} cy={p.y * 100} r="1.3" fill="var(--app-accent)" />)}
        </svg>
      </button>
      <details><summary className={TYPOGRAPHY_CLASSNAMES.helperText}>Adjust corners with keyboard</summary>
        {corners.map((point, index) => <div key={index} className="grid grid-cols-2 gap-2">{(["x", "y"] as const).map(axis => <label key={axis} className={TYPOGRAPHY_CLASSNAMES.helperText}>Corner {index + 1} {axis}<input type="range" min="0" max="1" step=".005" value={point[axis]} disabled={busy} className="min-h-11 w-full" onChange={event => { const next = [...corners] as CardCorners; next[index] = { ...point, [axis]: Number(event.currentTarget.value) }; setCorners(next); }} /></label>)}</div>)}
      </details>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" size="compact" disabled={busy || !validCardCorners(corners)} onClick={() => void scan()}>Read card</Button>
        <Button type="button" variant="ghost" size="compact" disabled={busy} onClick={() => { setCorners(FULL_CARD); setCornerIndex(0); }}>Use full photo</Button>
        <Button type="button" variant="ghost" size="compact" onClick={release}>Cancel scan</Button>
      </div>
    </section>}
    {busy ? <div className={styles.scanProgress} role="status"><Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Reading on your device…</div> : null}
    {notice ? <p role="status" className={styles.scanHint}>{notice}</p> : null}
  </div>;
}
