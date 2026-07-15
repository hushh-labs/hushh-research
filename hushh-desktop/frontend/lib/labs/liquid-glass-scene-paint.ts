"use client";

import { useEffect, useState } from "react";

export const LAB_SCENE_IMAGE_URL =
  "https://images.unsplash.com/photo-1651784627380-58168977f4f9?q=80&w=987&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D";

export type LabBackdropOptions = {
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
  image: HTMLImageElement | null;
  sceneWidth?: number;
  sceneHeight?: number;
  padding?: number;
};

export function useLabSceneImage(enabled: boolean) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      setImage(null);
      return;
    }

    let cancelled = false;
    const next = new Image();
    next.crossOrigin = "anonymous";
    next.decoding = "async";
    next.src = LAB_SCENE_IMAGE_URL;
    next.onload = () => {
      if (!cancelled) setImage(next);
    };
    next.onerror = () => {
      if (!cancelled) setImage(null);
    };

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return image;
}

export function paintLabBackdrop(
  ctx: CanvasRenderingContext2D,
  { width, height, offsetX = 0, offsetY = 0, image, sceneWidth, sceneHeight, padding = 0 }: LabBackdropOptions
) {
  const sw = sceneWidth ?? width;
  const sh = sceneHeight ?? height;
  const renderX = -padding;
  const renderY = -padding;
  const renderW = width + padding * 2;
  const renderH = height + padding * 2;

  if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
    const scale = Math.max(sw / image.naturalWidth, sh / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    const cropX = (drawWidth - sw) / 2;
    const cropY = (drawHeight - sh) / 2;

    ctx.drawImage(image, -cropX - offsetX, -cropY - offsetY, drawWidth, drawHeight);
    ctx.fillStyle = "rgba(6, 7, 10, 0.16)";
    ctx.fillRect(renderX, renderY, renderW, renderH);
    return;
  }

  const gradient = ctx.createRadialGradient(
    sw * 0.12 - offsetX,
    -sh * 0.05 - offsetY,
    0,
    sw * 0.52 - offsetX,
    sh * 0.92 - offsetY,
    Math.max(sw, sh) * 1.1
  );
  gradient.addColorStop(0, "#5f748f");
  gradient.addColorStop(0.28, "#2b3240");
  gradient.addColorStop(0.62, "#121722");
  gradient.addColorStop(1, "#080a10");

  ctx.fillStyle = gradient;
  ctx.fillRect(renderX, renderY, renderW, renderH);

  const gridSize = 24;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  const startX = renderX - ((offsetX % gridSize) + gridSize) % gridSize;
  const startY = renderY - ((offsetY % gridSize) + gridSize) % gridSize;

  for (let x = startX; x <= renderX + renderW; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, renderY);
    ctx.lineTo(x + 0.5, renderY + renderH);
    ctx.stroke();
  }
  for (let y = startY; y <= renderY + renderH; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(renderX, y + 0.5);
    ctx.lineTo(renderX + renderW, y + 0.5);
    ctx.stroke();
  }
}

export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
