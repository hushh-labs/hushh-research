"use client";

import { useId, useRef } from "react";
import { validCardCorners, type CardCorners, type CardPoint } from "@/lib/wallet/card-scan-image";
import styles from "./secure-card-add-form.module.css";

const NAMES = ["Top left", "Top right", "Bottom right", "Bottom left"];

/** Four direct, touch-sized handles; pixels stay in the owner's current capture. */
export function WalletCardCrop({ url, corners, disabled, onChange }: {
  url: string; corners: CardCorners; disabled: boolean; onChange: (corners: CardCorners) => void;
}) {
  const canvas = useRef<HTMLDivElement>(null), drag = useRef<number | null>(null);
  const instructions = useId();
  const move = (index: number, point: CardPoint) => {
    const next = [...corners] as CardCorners;
    next[index] = { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
    // A handle cannot cross its neighbor or collapse the readable card area.
    if (validCardCorners(next)) onChange(next);
  };
  return <>
    <p id={instructions} className={styles.scanHint}>Drag the corners to the edges of your card, then tap Read card. You can also use the full photo.</p>
    <div className={styles.cropStage}>
      <div ref={canvas} className={styles.cropCanvas}>
        {/* Owner-local pixels must not pass through Next image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Your unsaved card photo" className={styles.cropImage} draggable={false} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={styles.cropOutline} aria-hidden="true">
          <path d={`M0 0H100V100H0Z M${corners.map(p => `${p.x * 100} ${p.y * 100}`).join(" L")}Z`} fill="black" fillOpacity=".4" fillRule="evenodd" />
          <polygon points={corners.map(p => `${p.x * 100},${p.y * 100}`).join(" ")} fill="none" stroke="var(--app-accent)" strokeWidth=".65" />
        </svg>
        {corners.map((point, index) => <button key={index} type="button" className={styles.cropHandle}
          aria-label={`${NAMES[index]} crop corner`} aria-describedby={instructions} disabled={disabled}
          style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          onPointerDown={event => { drag.current = index; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => {
            if (drag.current !== index || disabled) return;
            const rect = canvas.current?.getBoundingClientRect();
            if (rect?.width && rect.height) move(index, { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
          }}
          onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = null; }}
          onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? .05 : .01;
            move(index, { x: point.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: point.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
          }}><span aria-hidden="true" /></button>)}
      </div>
    </div>
  </>;
}
