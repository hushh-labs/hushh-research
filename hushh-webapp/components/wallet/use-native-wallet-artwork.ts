"use client";

import { useEffect, useState } from "react";
import { buildWalletCardSvg, walletCardImageKey } from "@/lib/wallet/wallet-card-image";
import type { WalletCardArtwork } from "@/lib/wallet/card-artwork";
import { WALLET_DEMO_CARDS, type WalletDemoProfile } from "./wallet-demo-cards";

function raster(source: Blob | string, signal: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    const picture = new Image(), url = typeof source === "string" ? source : URL.createObjectURL(source);
    let finished = false;
    const timeout = setTimeout(() => finish(null), 8000);
    const finish = (value: string | null) => {
      if (finished) return; finished = true; clearTimeout(timeout);
      picture.onload = picture.onerror = null; signal.removeEventListener("abort", abort);
      if (typeof source !== "string") URL.revokeObjectURL(url);
      resolve(value);
    };
    const abort = () => { picture.src = ""; finish(null); };
    signal.addEventListener("abort", abort, { once: true });
    picture.onload = () => {
      try {
        if (signal.aborted) { finish(null); return; }
        const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = Math.round(512 / (85.6 / 53.98));
        const context = canvas.getContext("2d"); if (!context) { finish(null); return; }
        const scale = Math.min(canvas.width / picture.naturalWidth, canvas.height / picture.naturalHeight);
        const width = picture.naturalWidth * scale, height = picture.naturalHeight * scale;
        context.drawImage(picture, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        const data = canvas.toDataURL("image/png"); canvas.width = canvas.height = 0;
        finish(data.length <= 400_000 ? data : null);
      } catch { finish(null); }
    };
    picture.onerror = () => finish(null);
    if (signal.aborted) abort(); else picture.src = url;
  });
}

/** Canonical artwork, not screenshots or another renderer. Two bounded image
 * workers release URLs and pending decodes on owner/input replacement. */
export function useNativeWalletArtwork(profile: WalletDemoProfile | null | undefined, artworks: Readonly<Record<string, WalletCardArtwork | undefined>> = {}) {
  const kinds = ["profile", "referral", "nws"] as const;
  const signature = JSON.stringify([kinds.map(kind => walletCardImageKey(kind, profile)), Object.entries(artworks).map(([id, art]) => [id, art && art.source !== "neutral" ? art.digest : null])]);
  const [result, setResult] = useState<{ signature: string; values: Readonly<Record<string, string>> } | null>(null);
  useEffect(() => {
    const controller = new AbortController(), values: Record<string, string> = {};
    const jobs: Array<() => Promise<void>> = kinds.map((kind, index) => async () => {
      const svg = await buildWalletCardSvg({ kind, profile, signal: controller.signal });
      const image = await raster(new Blob([svg], { type: "image/svg+xml" }), controller.signal);
      if (image) values[WALLET_DEMO_CARDS[index]!.cardId] = image;
    });
    for (const [id, art] of Object.entries(artworks)) if (art && art.source !== "neutral") jobs.push(async () => {
      const image = await raster(art.image, controller.signal); if (image) values[id] = image;
    });
    let cursor = 0;
    const worker = async () => { while (!controller.signal.aborted && cursor < jobs.length) { const job = jobs[cursor++]!; try { await job(); } catch { /* Existing neutral fallback. */ } } };
    void Promise.all([worker(), worker()]).then(() => { if (!controller.signal.aborted) setResult({ signature, values }); });
    return () => controller.abort();
    // Complete visible-value identity, not object allocation, owns this work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return result?.signature === signature ? result.values : {};
}
