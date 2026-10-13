"use client";

import { useEffect, useRef } from "react";
import NextImage from "next/image";

export type OnePresenceState = "connected" | "thinking" | "working" | "answering";

/** Presentation only: observe running work, never infer intent from text. */
export function resolveOnePresenceState({ drafting, answering }: {
  drafting: boolean;
  answering: boolean;
}): OnePresenceState {
  if (drafting) return "working";
  return answering ? "thinking" : "connected";
}

const portrait = {
  connected: "/one-presence/profile-hd.png",
  working: "/one-presence/drafting-hd.png",
  thinking: "/one-presence/thinking-hd.png",
  answering: "/one-presence/thinking-hd.png",
} satisfies Record<OnePresenceState, string>;

/** Compact work states keep the 72-frame animation; large portraits stay sharp. */
export function OnePresenceAvatar({ state, presentation = "compact", className }: {
  state: OnePresenceState;
  presentation?: "compact" | "profile";
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (presentation === "profile" || state === "connected") return;
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = new Image();
    context.clearRect(0, 0, 128, 128);
    canvas.style.backgroundImage = `url('${portrait[state]}')`;
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
    image.src = `/one-presence/${state === "answering" ? "thinking" : state}.webp`;
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
  }, [presentation, state]);
  if (presentation === "profile" || state === "connected") {
    return <NextImage src={portrait[state]} width={1254} height={1254} alt=""
      aria-hidden="true" data-one-presence-state={state}
      unoptimized loading="eager" decoding="async"
      className={className ?? "block size-16 shrink-0"} />;
  }
  return <canvas ref={ref} width={128} height={128} aria-hidden="true"
    data-one-presence-state={state}
    className="block size-16 shrink-0 bg-contain bg-center bg-no-repeat"
    style={{ backgroundImage: `url('${portrait[state]}')` }} />;
}
