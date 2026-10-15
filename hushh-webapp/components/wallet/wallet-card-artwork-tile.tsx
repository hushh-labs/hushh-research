"use client";

import { useEffect, useRef, useState } from "react";
import { WalletService, type WalletNetworkContext } from "@/lib/services/wallet-service";
import type { WalletArtworkVariant } from "@/lib/wallet/card-artwork";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { cn } from "@/lib/utils";
import { useWalletArtworkVisibility } from "@/lib/wallet/use-wallet-artwork-visibility";

/** Only authenticated, revalidated bytes reach an image element. No remote src. */
export function WalletCardArtworkTile({ context, variant, catalogVersion, selected, onSelect }: {
  context: WalletNetworkContext; variant: WalletArtworkVariant; catalogVersion: string;
  selected: boolean; onSelect: () => void;
}) {
  const element = useRef<HTMLButtonElement>(null);
  const [image, setImage] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const { userId, vaultOwnerToken } = context;
  const visible = useWalletArtworkVisibility(context, image ? { ...variant, catalogVersion } : undefined, true);
  useEffect(() => {
    const controller = new AbortController();
    setImage(null); setUnavailable(false);
    let started = false;
    const load = () => {
      if (started) return; started = true;
      void WalletService.previewCardArtwork({ userId, vaultOwnerToken }, variant, catalogVersion, controller.signal)
        .then(value => { if (!controller.signal.aborted) setImage(value); })
        .catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    };
    // Load visible tiles and their neighbours, rather than downloading a feed.
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { load(); observer?.disconnect(); }
    }, { rootMargin: "160px" });
    if (observer && element.current) observer.observe(element.current); else load();
    return () => { controller.abort(); observer?.disconnect(); };
  }, [userId, vaultOwnerToken, variant, catalogVersion]);
  return <button ref={element} type="button" aria-pressed={selected} aria-label={variant.label} onClick={onSelect}
    className={cn("flex w-40 shrink-0 snap-start flex-col gap-2 rounded-2xl border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--app-accent)]", selected ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-surface)]" : "border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)]")}>
    <span className="flex h-24 w-full items-center justify-center overflow-hidden rounded-lg">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {image && visible ? <img src={image} alt="" className="h-full w-full object-contain" /> : <span className={TYPOGRAPHY_CLASSNAMES.helperText}>{unavailable || image ? "Preview unavailable" : "Loading design…"}</span>}
    </span>
    <span className={TYPOGRAPHY_CLASSNAMES.helperText}>{variant.issuerName ?? "Approved design"}</span>
    <span className={TYPOGRAPHY_CLASSNAMES.mediumRowLabel}>{variant.productName ?? variant.label}</span>
    <span className={TYPOGRAPHY_CLASSNAMES.helperText}>{variant.variantName ?? variant.label}{selected ? " · Selected" : ""}</span>
  </button>;
}
