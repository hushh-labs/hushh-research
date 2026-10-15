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

// Every embedded animation image is 128px; larger backing buffers add work,
// not image detail. The HD loading/reduced-motion portraits remain separate.
const nativeFrameSize = 128;

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
    let frame: number | null = null;
    let completedFrame = false;
    const finish = () => {
      // A timer's computed style can reach the endpoint ahead of a painted
      // frame. Keep both layers until the endpoint survives a paint boundary.
      const complete = Number(getComputedStyle(target).opacity) === 1;
      if (!complete || !completedFrame) {
        completedFrame = complete;
        frame = window.requestAnimationFrame(finish);
        return;
      }
      setDisplayed(fadingTo);
      setFadingTo(null);
      setReady(current => current === fadingTo ? null : current);
    };
    const timer = window.setTimeout(() => { frame = window.requestAnimationFrame(finish); }, duration);
    return () => {
      window.clearTimeout(timer);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [fadingTo]);

  return (
    <span ref={surfaceRef} aria-hidden="true" data-one-presence-state={state} className={`block relative isolate ${className ?? "size-11 shrink-0 md:size-18"}`}>
      {[displayed, ...(fadingTo ? [fadingTo] : []), ...(incoming ? [incoming] : [])].map(layer => (
        <span key={layer.state} data-one-presence-artwork={layer.state}
          data-one-presence-layer={layer === displayed ? "current" : "incoming"}
          className="absolute inset-0 size-full motion-safe:transition-opacity motion-safe:duration-[var(--motion-duration-xl)] motion-safe:ease-[var(--motion-ease-decelerate)]"
          style={{ mixBlendMode: fadingTo ? "plus-lighter" : "normal", opacity: layer === displayed ? (fadingTo ? 0 : 1) : (layer === fadingTo ? 1 : 0) }}>
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
    const paintProbe = document.createElement("canvas");
    paintProbe.width = paintProbe.height = 8;
    const probeContext = paintProbe.getContext("2d", { willReadFrequently: true });

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
    const resizePlayback = () => {
      if (!instance || !ready) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      // Rive truncates its canvas dimensions. A 0.01px backing-pixel bias
      // absorbs fractional square bounds while both axes still truncate to
      // at most 128px (the largest scaled dimension is only 128.01px).
      const ratio = Math.min(window.devicePixelRatio || 1, (nativeFrameSize + 0.01) / Math.max(width, height));
      const pixelWidth = Math.min(nativeFrameSize, Math.floor(width * ratio));
      const pixelHeight = Math.min(nativeFrameSize, Math.floor(height * ratio));
      // Rive can resize itself at device DPR after a hidden surface returns.
      // Actual pixel bounds own this image-backed surface; changing CSS size
      // with the same target buffer must not clear an already-painted frame.
      if (canvas.width === pixelWidth && canvas.height === pixelHeight) return;
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
      firstFrame = null;
      instance.resizeDrawingSurfaceToCanvas(ratio);
      // Only the SDK resizes the bitmap: direct width/height writes can erase
      // its synchronous draw without invalidating changed-frame rendering.
      presented = false;
      showPoster();
    };
    const sync = () => {
      if (disposed) return;
      const play = canPlay();
      if (!play) {
        canvas.dataset.onePresencePlayback = "paused";
        if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
        firstFrame = null;
        instance?.pause(stateMachine);
        instance?.stopRendering();
        showPoster();
        fallback = motion.matches || document.hidden || appInteractionCoordinator.getLifecycleSnapshot().state !== "active";
        if (fallback) notifyReady();
      } else if (instance && ready) {
        resizePlayback();
        fallback = false;
        instance.play(stateMachine);
        if (presented) {
          canvas.dataset.onePresencePlayback = "playing";
          canvas.style.visibility = "visible";
          poster.style.visibility = "hidden";
        } else if (firstFrame === null) {
          // Embedded images can decode after onLoad. Observe painted coverage
          // across the artboard, independent of pose/engine raster placement.
          // The 8px probe is bounded and never updates React per frame.
          canvas.dataset.onePresencePlayback = "waiting-for-paint";
          const started = performance.now();
          const awaitPaint = () => {
            firstFrame = null;
            if (disposed || !canPlay()) return;
            probeContext?.clearRect(0, 0, 8, 8);
            probeContext?.drawImage(canvas, 0, 0, 8, 8);
            const pixels = probeContext?.getImageData(0, 0, 8, 8).data;
            if (pixels?.some((alpha, index) => index % 4 === 3 && alpha > 0)) {
              presented = true;
              canvas.dataset.onePresencePlayback = "playing";
              sync();
              notifyReady();
            } else if (performance.now() - started < 5000) {
              firstFrame = window.requestAnimationFrame(awaitPaint);
            } else {
              instance?.cleanup();
              instance = null;
              ready = false;
              fallback = true;
              canvas.dataset.onePresencePlayback = "paint-timeout";
              showPoster();
              notifyReady();
            }
          };
          firstFrame = window.requestAnimationFrame(awaitPaint);
        }
      } else if (play && !loading) {
        loading = true;
        canvas.dataset.onePresencePlayback = "loading";
        // Browser-only import; the WASM and artwork stay on the app's origin.
        void import("@rive-app/canvas").then((runtime) => {
          if (disposed) return;
          runtime.RuntimeLoader.setWasmUrl("/one-presence/rive.wasm");
          runtime.RuntimeLoader.setWasmFallbackUrl(null);
          instance = new runtime.Rive({
            canvas,
            src: `/one-presence/${state}.riv`,
            enableRiveAssetCDN: false,
            // Let Rive redraw changed frames; the idle loop holds one image
            // for most of its timeline, so continuous bitmap redraws add work.
            stateMachine,
            shouldDisableRiveListeners: true,
            autoplay: false,
            layout: new runtime.Layout({ fit: runtime.Fit.Contain, alignment: runtime.Alignment.Center }),
            onLoad: () => {
              // Rive initializes paused state machines after firing onLoad.
              // Resize/play only after that setup; an early draw can consume
              // the first pose's invalidation and leave an idle loop blank.
              queueMicrotask(() => {
                if (disposed || !instance) return;
                ready = true;
                instance.resizeToCanvas();
                sync();
              });
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
              canvas.dataset.onePresencePlayback = "asset-error";
              notifyReady();
            },
          });
        }).catch(() => {
          if (!disposed) { canvas.dataset.onePresencePlayback = "runtime-error"; showPoster(); fallback = true; notifyReady(); }
        });
      }
    };
    showPoster();
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    observer?.observe(canvas);
    let resizeFrame: number | null = null;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      // Run after Rive's own size observer so its zero-size recovery cannot
      // leave the source-sized buffer enlarged again.
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (!disposed) { resizePlayback(); sync(); }
      });
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
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
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
