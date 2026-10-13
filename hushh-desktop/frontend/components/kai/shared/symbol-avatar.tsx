"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function getCompanyLogoUrl({
  symbol,
  name,
  isCash = false,
}: {
  symbol: string;
  name?: string | null;
  isCash?: boolean;
}): string | null {
  if (isCash) {
    if (/chase/i.test(String(name || ""))) {
      return "https://financialmodelingprep.com/image-stock/JPM.png";
    }
    return null;
  }

  const normalized = String(symbol || "").trim().toUpperCase();
  if (!normalized) return null;
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(normalized)}.png`;
}

function getMarkerGlyph(symbol: string, isCash: boolean): string {
  if (isCash) return "$";
  const cleaned = String(symbol || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  return cleaned.length > 0 ? cleaned.charAt(0) : "•";
}

function getIconStyle(key: string, isCash: boolean): CSSProperties {
  const baseHue = isCash ? 145 : hashText(key || "holding") % 360;
  const accentHue = (baseHue + 38) % 360;
  return {
    background: `linear-gradient(140deg, hsla(${baseHue}, 60%, 30%, 0.95), hsla(${accentHue}, 66%, 22%, 0.95))`,
    borderColor: `hsla(${baseHue}, 68%, 60%, 0.28)`,
  };
}

const SIZE_CLASSES = {
  sm: {
    shell: "h-5 w-5",
    image: "h-3.5 w-3.5",
    text: "text-[9px]",
  },
  md: {
    shell: "h-10 w-10 rounded-2xl",
    image: "h-6 w-6",
    text: "text-[12px]",
  },
  lg: {
    shell: "h-11 w-11 rounded-2xl",
    image: "h-7 w-7",
    text: "text-[13px]",
  },
} as const;

export function SymbolAvatar({
  symbol,
  name,
  isCash = false,
  size = "md",
  className,
}: {
  symbol: string;
  name?: string | null;
  isCash?: boolean;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  const logoUrl = getCompanyLogoUrl({ symbol, name, isCash });
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    setLogoFailed(false);
  }, [logoUrl]);

  const markerGlyph = getMarkerGlyph(symbol, isCash);
  const iconStyle = getIconStyle(symbol || name || "holding", isCash);
  const sizeClasses = SIZE_CLASSES[size];

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border",
        logoUrl && !logoFailed
          ? "border-white/25 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
          : "text-white/85 shadow-[inset_0_1px_1px_rgba(255,255,255,0.18)]",
        sizeClasses.shell,
        sizeClasses.text,
        !logoUrl || logoFailed ? "font-bold uppercase tracking-wide" : undefined,
        className
      )}
      style={logoUrl && !logoFailed ? undefined : iconStyle}
      aria-hidden="true"
    >
      {logoUrl && !logoFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          className={cn("object-contain", sizeClasses.image)}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        markerGlyph
      )}
    </span>
  );
}
