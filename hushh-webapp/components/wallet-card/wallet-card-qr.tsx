"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { encodeQrCode } from "@/components/wallet-card/qr-code";

const QUIET_ZONE_MODULES = 4;

interface ModuleRun {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** Merge each row's dark modules into runs so the SVG stays small. */
function darkRuns(size: number, modules: Uint8Array): ModuleRun[] {
  const runs: ModuleRun[] = [];
  for (let y = 0; y < size; y += 1) {
    let start = -1;
    for (let x = 0; x <= size; x += 1) {
      const dark = x < size && (modules[y * size + x] ?? 0) === 1;
      if (dark && start < 0) {
        start = x;
      } else if (!dark && start >= 0) {
        runs.push({ x: start, y, width: x - start });
        start = -1;
      }
    }
  }
  return runs;
}

/**
 * The share link rendered as a scannable QR.
 *
 * Colours are deliberately fixed to black on white rather than theme tokens:
 * a dark-mode inversion would flip the contrast polarity and stop cameras
 * reading the code.
 */
export function WalletCardQr({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const symbol = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const matrix = encodeQrCode(trimmed);
      return { matrix, runs: darkRuns(matrix.size, matrix.modules) };
    } catch {
      return null;
    }
  }, [value]);

  if (!symbol) {
    return (
      <div
        className={cn(
          "flex aspect-square w-full items-center justify-center rounded-2xl border border-dashed p-6 text-center text-[12px] text-muted-foreground",
          className,
        )}
      >
        The QR can't be shown right now.
      </div>
    );
  }

  const extent = symbol.matrix.size + QUIET_ZONE_MODULES * 2;

  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn("h-auto w-full rounded-2xl bg-white", className)}
    >
      <rect x="0" y="0" width={extent} height={extent} fill="#ffffff" />
      <g fill="#000000">
        {symbol.runs.map((run) => (
          <rect
            key={`${run.y}-${run.x}`}
            x={run.x + QUIET_ZONE_MODULES}
            y={run.y + QUIET_ZONE_MODULES}
            width={run.width}
            height={1}
          />
        ))}
      </g>
    </svg>
  );
}
