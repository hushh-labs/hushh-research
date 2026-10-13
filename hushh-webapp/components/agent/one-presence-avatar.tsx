"use client";

import { useEffect, useRef } from "react";

export type OnePresenceState = "connected" | "thinking" | "working" | "answering";

/** Fixed-canvas frames: 72 frames, 24 FPS, nine columns. */
export function OnePresenceAvatar({ state }: { state: OnePresenceState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = new Image();
    context.clearRect(0, 0, 128, 128);
    canvas.style.backgroundImage = "url('/one-presence/still.webp')";
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false;
    let visible = false;
    let loaded = false;
    let frameRequest = 0;
    let start = 0;
    let previous = -1;
    const draw = (frame: number) => {
      if (!loaded || frame === previous) return;
      context.clearRect(0, 0, 128, 128);
      context.drawImage(image, (frame % 9) * 128, Math.floor(frame / 9) * 128, 128, 128, 0, 0, 128, 128);
      previous = frame;
    };
    const tick = (now: number) => {
      if (disposed) return;
      draw(Math.floor((now - start) * 24 / 1000) % 72);
      frameRequest = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frameRequest);
      if (!loaded || disposed) return;
      if (motion.matches || document.hidden || !visible) { draw(0); return; }
      start = performance.now();
      frameRequest = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(canvas);
    image.onload = () => {
      if (disposed) return;
      loaded = true;
      canvas.style.backgroundImage = "none";
      draw(0);
      sync();
    };
    image.src = `/one-presence/${state}.webp`;
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    return () => {
      disposed = true;
      cancelAnimationFrame(frameRequest);
      observer.disconnect();
      image.onload = null;
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
    };
  }, [state]);
  return <canvas ref={ref} width={128} height={128} aria-hidden="true" className="block size-16 shrink-0 bg-contain bg-center bg-no-repeat" style={{ backgroundImage: "url('/one-presence/still.webp')" }} />;
}
