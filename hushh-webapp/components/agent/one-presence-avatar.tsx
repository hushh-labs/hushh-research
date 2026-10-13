"use client";

import { useEffect, useRef } from "react";
import type { Rive } from "@rive-app/canvas";
import NextImage from "next/image";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

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

/** Native Rive Solo timelines preserve the authored 72-frame, 24 FPS loops. */
export function OnePresenceAvatar({ state, className, presentation = "compact" }: {
  state: OnePresenceState;
  className?: string;
  presentation?: "compact" | "profile";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const posterRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const poster = posterRef.current;
    if (!canvas || !poster || state === "connected") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stateMachine = "State Machine 1";
    const artwork = state === "answering" ? "thinking" : state;
    let disposed = false;
    let visible = typeof IntersectionObserver === "undefined";
    let loading = false;
    let ready = false;
    let instance: Rive | null = null;

    const showPoster = () => {
      canvas.style.visibility = "hidden";
      poster.style.visibility = "visible";
    };
    const sync = () => {
      if (disposed) return;
      const play = visible && !document.hidden && !motion.matches && appInteractionCoordinator.getLifecycleSnapshot().state === "active";
      if (instance && ready) {
        if (play) {
          instance.play(stateMachine);
          instance.startRendering();
          canvas.style.visibility = "visible";
          poster.style.visibility = "hidden";
        } else {
          instance.pause(stateMachine);
          instance.stopRendering();
          showPoster();
        }
      } else if (play && !loading) {
        loading = true;
        // Browser-only import; the WASM and artwork stay on the app's origin.
        void import("@rive-app/canvas").then((runtime) => {
          if (disposed) return;
          runtime.RuntimeLoader.setWasmUrl("/one-presence/rive.wasm");
          runtime.RuntimeLoader.setWasmFallbackUrl(null);
          instance = new runtime.Rive({
            canvas,
            src: `/one-presence/${artwork}.riv`,
            enableRiveAssetCDN: false,
            stateMachine,
            shouldDisableRiveListeners: true,
            autoplay: false,
            layout: new runtime.Layout({ fit: runtime.Fit.Contain, alignment: runtime.Alignment.Center }),
            onLoad: () => {
              if (disposed || !instance) return;
              ready = true;
              instance.resizeDrawingSurfaceToCanvas();
              sync();
            },
            onLoadError: () => {
              if (disposed) return;
              ready = false;
              instance?.cleanup();
              instance = null;
              showPoster();
            },
          });
        }).catch(() => {
          if (!disposed) showPoster();
        });
      }
    };
    showPoster();
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    observer?.observe(canvas);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (!disposed && instance && ready) {
        instance.resizeDrawingSurfaceToCanvas();
        sync();
      }
    });
    resize?.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    const unsubscribeLifecycle = appInteractionCoordinator.subscribeLifecycle(sync);
    sync();
    return () => {
      disposed = true;
      observer?.disconnect();
      resize?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
      unsubscribeLifecycle();
      instance?.cleanup();
    };
  }, [presentation, state]);

  if (state === "connected") {
    return <NextImage src={portrait[state]} width={1254} height={1254} alt=""
      aria-hidden="true" data-one-presence-state={state}
      unoptimized loading="eager" decoding="async"
      className={className ?? "block size-16 shrink-0"} />;
  }
  return (
    <span aria-hidden="true" data-one-presence-state={state} className={`block relative ${className ?? "size-16 shrink-0"}`}>
      <NextImage ref={posterRef} src={portrait[state]} alt="" width={1254} height={1254}
        unoptimized loading="eager" decoding="async" className="absolute inset-0 size-full object-contain" />
      <canvas ref={canvasRef} width={128} height={128} className="absolute inset-0 size-full" style={{ visibility: "hidden" }} />
    </span>
  );
}
