"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { WalletService, type WalletNetworkContext } from "@/lib/services/wallet-service";
import { approveWalletPhoto, type WalletCardArtwork, type WalletArtworkResolution } from "@/lib/wallet/card-artwork";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { scanWalletCardForReview } from "@/lib/services/wallet-card-scan";
import type { CardImageBox, CardPoint } from "@/lib/wallet/card-scan-image";
import { WalletCardArtworkTile } from "./wallet-card-artwork-tile";

/** Picker receives only an allowed IIN, never a complete card or vault key. */
export function WalletCardArtworkPicker({ context, prefix, panLength, active, sanitized, candidate, value, onChange, onBusyChange, showSimpleDesign = true, compact = false }: {
  context: WalletNetworkContext | null; prefix: string; panLength: number;
  active: boolean; sanitized?: Blob; candidate?: Blob; onChange: (artwork: WalletCardArtwork) => void;
  onBusyChange?: (busy: boolean) => void;
  value?: WalletCardArtwork;
  showSimpleDesign?: boolean;
  compact?: boolean;
}) {
  const [resolution, setResolution] = useState<WalletArtworkResolution | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ photo: Blob; url: string } | null>(null);
  const [editedPhoto, setEditedPhoto] = useState<{ source?: Blob; result: { candidate?: Blob; sanitized?: Blob } } | null>(null);
  const [maskStart, setMaskStart] = useState<CardPoint | null>(null);
  const [mask, setMask] = useState<CardImageBox | null>(null);
  const sourcePhoto = sanitized ?? candidate;
  const edited = editedPhoto?.source === sourcePhoto ? editedPhoto?.result : null;
  const displayedPhoto = edited?.candidate ?? sourcePhoto;
  const inspectedPhoto = edited ? edited.sanitized : sanitized;
  const visiblePreview = preview?.photo === displayedPhoto ? preview?.url : null;
  const userId = context?.userId, ownerToken = context?.vaultOwnerToken;
  const current = useRef(context);
  const activeRef = useRef(active);
  useLayoutEffect(() => { current.current = context; activeRef.current = active; }, [context, active]);
  const operation = useRef<AbortController | null>(null), photoGeneration = useRef(0);
  const choiceRevision = useRef(0);
  useLayoutEffect(() => { choiceRevision.current = 0; }, [userId, prefix, panLength]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useLayoutEffect(() => { photoGeneration.current++; operation.current?.abort(); setBusy(false); setEditedPhoto(null); setMask(null); setMaskStart(null); }, [sanitized, candidate, active]);
  useEffect(() => {
    const controller = new AbortController(); setResolution(null); setNotice("");
    operation.current?.abort(); setBusy(false);
    if (active && userId && ownerToken && /^(?:\d{6}|\d{8})$/.test(prefix) && panLength >= 13 && panLength <= 19) {
      const timer = setTimeout(() => {
        void WalletService.resolveCardArtwork({ userId, vaultOwnerToken: ownerToken }, { iinPrefix: prefix, panLength }, controller.signal).then(value => {
          if (!controller.signal.aborted) setResolution(value);
        }).catch(() => { if (!controller.signal.aborted) setNotice("Original design unavailable."); });
      }, 250);
      return () => { clearTimeout(timer); controller.abort(); operation.current?.abort(); };
    }
    return () => { controller.abort(); operation.current?.abort(); };
  }, [active, userId, ownerToken, prefix, panLength]);
  useEffect(() => {
    if (!active || !userId || !ownerToken || resolution?.match !== "exact" || resolution.variants.length !== 1 || choiceRevision.current) return;
    const controller = new AbortController(); choiceRevision.current++; operation.current = controller; setBusy(true);
    void WalletService.selectCardArtwork({ userId, vaultOwnerToken: ownerToken }, resolution.variants[0]!, resolution.catalogVersion, controller.signal).then(value => {
      if (!controller.signal.aborted) { onChange(value); setNotice("Original design selected. Review it before adding your card."); }
    }).catch(() => { if (!controller.signal.aborted) setNotice("Original design unavailable."); })
      .finally(() => { if (operation.current === controller) { operation.current = null; setBusy(false); } });
    return () => controller.abort();
  }, [active, userId, ownerToken, resolution, onChange]);
  useEffect(() => {
    if (!displayedPhoto || !active) { setPreview(null); return; }
    const url = URL.createObjectURL(displayedPhoto); setPreview({ photo: displayedPhoto, url }); return () => URL.revokeObjectURL(url);
  }, [displayedPhoto, active]);
  const apply = async (get: (signal: AbortSignal) => Promise<WalletCardArtwork>) => {
    if (!active || !context) return;
    const owner = context, epoch = snapshotVaultSessionEpoch(), controller = new AbortController();
    choiceRevision.current++;
    operation.current?.abort(); operation.current = controller; setBusy(true); setNotice("");
    try {
      const value = await get(controller.signal);
      if (controller.signal.aborted || !activeRef.current || !isVaultSessionEpochCurrent(epoch) || current.current?.userId !== owner.userId || current.current.vaultOwnerToken !== owner.vaultOwnerToken) return;
      onChange(value); setNotice("Design selected. Review it before adding your card.");
    } catch { if (!controller.signal.aborted) setNotice("This design is unavailable. Try another design."); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  };
  if (!active || (!showSimpleDesign && !resolution?.variants.length && !visiblePreview)) return null;
  return <section aria-label="Card design" className="flex flex-col gap-3">
    {!compact ? <><h3 className={TYPOGRAPHY_CLASSNAMES.rowLabel}>Choose your card design</h3>
    <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Select the design that matches your card.</p></> : null}
    {resolution?.metadata && Object.values(resolution.metadata).some(Boolean) ? <p className={TYPOGRAPHY_CLASSNAMES.helperText}>{[resolution.metadata.issuerName, resolution.metadata.productFamily, resolution.metadata.cardType, resolution.metadata.tier, resolution.metadata.country].filter(Boolean).join(" · ")}</p> : null}
    {showSimpleDesign && resolution?.match === "unknown" ? <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Original design unavailable. You can use a neutral design.</p> : null}
    {resolution && resolution.variants.length ? <>
      <div className="flex snap-x gap-3 overflow-x-auto p-1" aria-label="Approved card designs">{context ? resolution.variants.map(variant => <WalletCardArtworkTile key={`${userId}:${ownerToken}:${resolution.catalogVersion}:${variant.assetId}`} context={context} variant={variant} catalogVersion={resolution.catalogVersion} selected={value?.source === "catalog" && value.assetId === variant.assetId} onSelect={() => void apply(signal => WalletService.selectCardArtwork(context, variant, resolution.catalogVersion, signal))} />) : null}</div>
    </> : null}
    {visiblePreview && context ? <>
      {/* Only flattened, locally inspected bytes are shown; never the raw scan. */}
      <button type="button" aria-label="Select area to remove from photo" disabled={busy} className="relative mx-auto block min-h-11 w-full max-w-[26.5rem] overflow-hidden rounded-2xl" onClick={event => {
        choiceRevision.current++; operation.current?.abort(); onChange({ source: "neutral", version: 1 });
        const rect = event.currentTarget.getBoundingClientRect(), point = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
        if (!maskStart) { setMaskStart(point); setMask(null); }
        else { setMask({ x0: Math.min(point.x, maskStart.x), y0: Math.min(point.y, maskStart.y), x1: Math.max(point.x, maskStart.x), y1: Math.max(point.y, maskStart.y) }); setMaskStart(null); }
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={visiblePreview} alt="Photo design with detected text removed" className="block h-auto w-full" />
        {mask ? <span aria-hidden="true" className="pointer-events-none absolute bg-black/80" style={{ left: `${mask.x0 * 100}%`, top: `${mask.y0 * 100}%`, width: `${(mask.x1 - mask.x0) * 100}%`, height: `${(mask.y1 - mask.y0) * 100}%` }} /> : null}
      </button>
      <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Check that no number, name, expiry, code or PIN is visible.</p>
      <p className={TYPOGRAPHY_CLASSNAMES.helperText}>To hide more, tap two opposite corners of the area, then remove it.</p>
      <details><summary className={TYPOGRAPHY_CLASSNAMES.helperText}>Adjust mask with keyboard</summary>
        <Button type="button" variant="ghost" size="compact" disabled={busy} onClick={() => { choiceRevision.current++; operation.current?.abort(); onChange({ source: "neutral", version: 1 }); setMaskStart(null); setMask({ x0: .1, y0: .4, x1: .9, y1: .9 }); }}>Select an area</Button>
        {mask ? <div className="grid grid-cols-2 gap-2">{(["x0", "y0", "x1", "y1"] as const).map(axis => <label key={axis} className={TYPOGRAPHY_CLASSNAMES.helperText}>Mask {axis}<input type="range" min="0" max="1" step=".005" value={mask[axis]} disabled={busy} className="min-h-11 w-full" onChange={event => { choiceRevision.current++; operation.current?.abort(); onChange({ source: "neutral", version: 1 }); const next = { ...mask, [axis]: Number(event.currentTarget.value) }; if (next.x1 > next.x0 && next.y1 > next.y0) setMask(next); }} /></label>)}</div> : null}
      </details>
      <Button type="button" variant="secondary" size="compact" disabled={busy || !mask} onClick={() => {
        if (!displayedPhoto || !mask) return;
        const controller = new AbortController(), version = photoGeneration.current; operation.current?.abort(); operation.current = controller; setBusy(true);
        void scanWalletCardForReview(displayedPhoto, controller.signal, { sanitizeOnly: true, masks: [mask] }).then(result => {
          if (controller.signal.aborted || version !== photoGeneration.current) return; setEditedPhoto({ source: sourcePhoto, result }); setMask(null); setMaskStart(null);
          setNotice(result.sanitized ? "Photo rechecked. Inspect it before approval." : "The photo needs more masking.");
        }).catch(() => { if (!controller.signal.aborted) setNotice("Photo inspection unavailable."); })
          .finally(() => { if (operation.current === controller) { operation.current = null; setBusy(false); } });
      }}>Remove selected area</Button>
      {inspectedPhoto ? <Button type="button" variant="secondary" size="compact" disabled={busy || Boolean(mask) || Boolean(maskStart)} onClick={() => void apply(async () => approveWalletPhoto(inspectedPhoto, context.userId))}>I checked — use photo</Button> : null}
    </> : null}
    {showSimpleDesign ? <Button type="button" variant="ghost" size="compact" aria-pressed={!value || value.source === "neutral"} onClick={() => { choiceRevision.current++; operation.current?.abort(); onChange({ source: "neutral", version: 1 }); setBusy(false); setNotice("Simple design selected."); }}>Use a simple design</Button> : null}
    {notice ? <p role="status" className={TYPOGRAPHY_CLASSNAMES.helperText}>{notice}</p> : null}
  </section>;
}
