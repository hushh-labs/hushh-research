"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Rive } from "@rive-app/canvas";
import NextImage from "next/image";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

export type OnePresenceState = "connected" | "thinking" | "working" | "answering";
type PresenceRequest = { state: OnePresenceState };

/** Presentation only: observe running work, never infer intent from text. */
export function resolveOnePresenceState({ drafting, answering, thinking }: {
  drafting: boolean;
  answering: boolean;
  thinking: boolean;
}): OnePresenceState {
  if (drafting) return "working";
  if (answering) return "answering";
  return thinking ? "thinking" : "connected";
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
  const request = useMemo(() => ({ state }), [state]);
  const requestedRef = useRef(request);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { requestedRef.current = request; }, [request]);
  const [displayed, setDisplayed] = useState(request);
  const [ready, setReady] = useState<typeof request | null>(null);
  const [fadingTo, setFadingTo] = useState<typeof request | null>(null);
  const incoming = displayed.state === state || fadingTo?.state === state ? null : request;
  const handleReady = useCallback((candidate: PresenceRequest) => {
    if (requestedRef.current === candidate) setReady(candidate);
  }, []);

  useEffect(() => {
    if (!fadingTo && incoming && ready === incoming) setFadingTo(incoming);
  }, [fadingTo, incoming, ready]);

  useEffect(() => {
    if (!fadingTo) return;
    // Keep the outgoing runtime until the shared opacity fade has completed.
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0
      : parseFloat(getComputedStyle(surfaceRef.current!).getPropertyValue("--motion-duration-xl")) || 150;
    const target = surfaceRef.current!.querySelector<HTMLElement>(`[data-one-presence-artwork="${fadingTo.state}"]`)!;
    let timer: number;
    const finish = () => {
      // A busy main thread can delay the CSS transition's start. Elapsed wall
      // time alone must never remove artwork that still contributes to the fade.
      if (Number(getComputedStyle(target).opacity) < 1) {
        timer = window.setTimeout(finish, 16);
        return;
      }
      setDisplayed(fadingTo);
      setFadingTo(null);
      setReady(current => current === fadingTo ? null : current);
    };
    timer = window.setTimeout(finish, duration);
    return () => window.clearTimeout(timer);
  }, [fadingTo]);

  return (
    <span ref={surfaceRef} aria-hidden="true" data-one-presence-state={state} className={`block relative isolate ${className ?? "size-16 shrink-0"}`}>
      {[displayed, ...(fadingTo ? [fadingTo] : []), ...(incoming ? [incoming] : [])].map(layer => (
        <span key={layer.state} data-one-presence-artwork={layer.state}
          data-one-presence-layer={layer === displayed ? "current" : "incoming"}
          className="absolute inset-0 size-full motion-safe:transition-opacity motion-safe:duration-[var(--motion-duration-xl)] motion-safe:ease-[var(--motion-ease-decelerate)]"
          style={{ mixBlendMode: "plus-lighter", opacity: layer === displayed ? (fadingTo ? 0 : 1) : (layer === fadingTo ? 1 : 0) }}>
          <OnePresencePlayback request={layer} presentation={presentation} onReady={layer === incoming ? handleReady : undefined} />
        </span>
      ))}
    </span>
  );
}

function OnePresencePlayback({ request, presentation, onReady }: {
  request: PresenceRequest;
  presentation: "compact" | "profile";
  onReady?: (request: PresenceRequest) => void;
}) {
  const state = request.state;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const posterRef = useRef<HTMLImageElement>(null);
  const onReadyRef = useRef({ request, onReady });
  useLayoutEffect(() => { onReadyRef.current = { request, onReady }; }, [onReady, request]);
  const notifyRef = useRef<(() => void) | null>(null);

  useEffect(() => { notifyRef.current?.(); }, [onReady, request]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const poster = posterRef.current;
    if (!canvas || !poster) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stateMachine = "State Machine 1";
    let disposed = false;
    let visible = typeof IntersectionObserver === "undefined";
    let loading = false;
    let ready = false;
    let instance: Rive | null = null;
    let firstFrame: number | null = null;
    let presented = false;
    let notifiedRequest: PresenceRequest | null = null;
    let fallback = false;

    const notifyReady = () => {
      const next = onReadyRef.current;
      const painted = presented && canvas.style.visibility === "visible";
      const posterReady = fallback && poster.style.visibility === "visible" && poster.complete && poster.naturalWidth > 0;
      if (!next.onReady || notifiedRequest === next.request || (!painted && !posterReady)) return;
      notifiedRequest = next.request;
      next.onReady(next.request);
    };
    notifyRef.current = notifyReady;

    const showPoster = () => {
      // Keep a painted frame frozen if the HD fallback is still loading.
      const usePoster = !presented || (poster.complete && poster.naturalWidth > 0);
      canvas.style.visibility = usePoster ? "hidden" : "visible";
      poster.style.visibility = usePoster ? "visible" : "hidden";
    };
    const onPosterLoad = () => { if (fallback) { showPoster(); notifyReady(); } };
    const canPlay = () => visible && !document.hidden && !motion.matches && appInteractionCoordinator.getLifecycleSnapshot().state === "active";
    const sync = () => {
      if (disposed) return;
      const play = canPlay();
      if (!play) {
        if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
        firstFrame = null;
        instance?.pause(stateMachine);
        instance?.stopRendering();
        showPoster();
        fallback = motion.matches || document.hidden || appInteractionCoordinator.getLifecycleSnapshot().state !== "active";
        if (fallback) notifyReady();
      } else if (instance && ready) {
        fallback = false;
        instance.play(stateMachine);
        instance.startRendering();
        if (presented) {
          canvas.style.visibility = "visible";
          poster.style.visibility = "hidden";
        } else if (firstFrame === null) {
          // Embedded images can decode after onLoad. Observe an actual painted
          // row before handing off; this bounded probe never updates React per frame.
          const started = performance.now();
          const awaitPaint = () => {
            firstFrame = null;
            if (disposed || !canPlay()) return;
            const pixels = canvas.getContext("2d")?.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
            if (pixels?.some((alpha, index) => index % 4 === 3 && alpha > 0)) {
              presented = true;
              sync();
              notifyReady();
            } else if (performance.now() - started < 5000) {
              firstFrame = window.requestAnimationFrame(awaitPaint);
            } else {
              instance?.cleanup();
              instance = null;
              ready = false;
              fallback = true;
              showPoster();
              notifyReady();
            }
          };
          firstFrame = window.requestAnimationFrame(awaitPaint);
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
            src: `/one-presence/${state}.riv`,
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
              if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
              firstFrame = null;
              instance?.cleanup();
              instance = null;
              showPoster();
              fallback = true;
              notifyReady();
            },
          });
        }).catch(() => {
          if (!disposed) { showPoster(); fallback = true; notifyReady(); }
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
    poster.addEventListener("load", onPosterLoad);
    motion.addEventListener("change", sync);
    const unsubscribeLifecycle = appInteractionCoordinator.subscribeLifecycle(sync);
    sync();
    return () => {
      disposed = true;
      notifyRef.current = null;
      observer?.disconnect();
      resize?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      poster.removeEventListener("load", onPosterLoad);
      motion.removeEventListener("change", sync);
      unsubscribeLifecycle();
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
      instance?.cleanup();
    };
  }, [presentation, state]);

  return (
    <>
      <NextImage ref={posterRef} src={portrait[state]} alt="" width={1254} height={1254}
        unoptimized loading="eager" decoding="async" className="absolute inset-0 size-full object-contain" />
      <canvas ref={canvasRef} width={128} height={128} className="absolute inset-0 size-full" style={{ visibility: "hidden" }} />
    </>
  );
}
