"use client";

import { useEffect, useState } from "react";
import { encodeQrCode } from "@/components/wallet-card/qr-code";

/** Canonical QR bytes and canonical card-export artwork, rasterised in memory.
 * No DOM capture, remote native fetch, native credential or persistence. */
export function useNativeWalletImages(qrValue?: string | null, file?: File | null) {
  const [qr, setQr] = useState<{ source: string; data: string } | null>(null);
  const [image, setImage] = useState<{ source: File; data: string } | null>(null);
  useEffect(() => {
    if (!qrValue) return;
    try {
      const code = encodeQrCode(qrValue), quiet = 4, scale = 5;
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = (code.size + quiet * 2) * scale;
      const context = canvas.getContext("2d"); if (!context) return;
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "#000000";
      for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.modules[y * code.size + x]) context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      setQr({ source: qrValue, data: canvas.toDataURL("image/png") });
      canvas.width = canvas.height = 0;
    } catch { setQr(null); }
    return () => setQr(null);
  }, [qrValue]);
  useEffect(() => {
    if (!file) return;
    let active = true;
    const source = URL.createObjectURL(file), picture = new Image();
    const clear = () => { picture.onload = null; picture.onerror = null; URL.revokeObjectURL(source); };
    picture.onload = () => {
      try {
        if (!active) return;
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = Math.round(640 / (85.6 / 53.98));
        canvas.getContext("2d")?.drawImage(picture, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/png");
        if (data.length <= 400_000) setImage({ source: file, data });
        canvas.width = canvas.height = 0;
      } finally { clear(); }
    };
    picture.onerror = clear; picture.src = source;
    return () => { active = false; clear(); setImage(null); };
  }, [file]);
  return { ...(qrValue && qr?.source === qrValue ? { qrData: qr.data } : {}), ...(file && image?.source === file ? { imageData: image.data } : {}) };
}
