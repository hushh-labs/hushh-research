"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Rive } from "@rive-app/canvas";
import NextImage from "next/image";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

export type OnePresenceState = "connected" | "thinking" | "working" | "answering";
type PresenceRequest = { state: OnePresenceState };

/** Presentation only: observe running work, never infer intent from text. */
export function resolveOnePresenceState({ working = false, drafting, answering, thinking }: {
  working?: boolean;
  drafting: boolean;
  answering: boolean;
  thinking: boolean;
}): OnePresenceState {
  if (working || drafting) return "working";
  if (answering) return "answering";
  return thinking ? "thinking" : "connected";
}

const portrait = {
  connected: "/one-presence/profile-hd.png",
  working: "/one-presence/drafting-hd.png",
  thinking: "/one-presence/thinking-hd.png",
  answering: "/one-presence/answering-hd.png",
} satisfies Record<OnePresenceState, string>;

// Portraits use one 1254px texture; typing uses sixteen 314px poses.
// Limit backing memory while covering
// the 224px panel and larger 256px presentations at three device pixels/CSS px.
const maxDrawingSurfaceSize = 768;
// One native loop is three seconds. Dwell begins after drawable artwork is
// presented, independently of how quickly the actual task completes.
const minimumPresenceMs = 3200;

/** HD portrait motion runs in native Rive with 72-frame, 24 FPS loops. */
export function OnePresenceAvatar({ state, className, presentation = "compact" }: {
  state: OnePresenceState;
  className?: string;
  presentation?: "compact" | "profile";
}) {
  const request = useMemo(() => ({ state }), [state]);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const [displayed, setDisplayed] = useState(request);
  const [pending, setPending] = useState<PresenceRequest[]>([]);
  const [ready, setReady] = useState<PresenceRequest | null>(null);
  const [displayedReady, setDisplayedReady] = useState<PresenceRequest | null>(null);
  const [holdUntil, setHoldUntil] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const [fadingTo, setFadingTo] = useState<PresenceRequest | null>(null);
  const failedRequest = useRef<PresenceRequest | null>(null);
  const observedRequest = useRef(request);
  const incoming = fadingTo || pending[0]?.state === displayed.state ? null : pending[0] ?? null;
  const candidates = useRef({ displayed, incoming });
  useLayoutEffect(() => { candidates.current = { displayed, incoming }; }, [displayed, incoming]);
  const handleReady = useCallback((candidate: PresenceRequest) => {
    if (candidates.current.displayed === candidate) setDisplayedReady(candidate);
    else if (candidates.current.incoming === candidate) setReady(candidate);
  }, []);

  useEffect(() => {
    let visible = typeof IntersectionObserver === "undefined";
    const sync = () => setActive(visible && !document.hidden && appInteractionCoordinator.getLifecycleSnapshot().state === "active");
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      sync();
    });
    observer?.observe(surfaceRef.current!);
    const unsubscribe = appInteractionCoordinator.subscribeLifecycle(sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => { observer?.disconnect(); unsubscribe(); document.removeEventListener("visibilitychange", sync); };
  }, []);

  useEffect(() => {
    if (observedRequest.current === request) return;
    observedRequest.current = request;
    // Keep each distinct observed activity once, in order, rather than dropping
    // a brief Working phase or building an unbounded history of repeated tools.
    setPending(queue => queue.some(candidate => candidate.state === request.state)
      || (!queue.length && !fadingTo && displayed.state === request.state)
      ? queue : [...queue, request]);
  }, [displayed.state, fadingTo, request]);

  useEffect(() => {
    if (!pending.length && !fadingTo && displayed.state !== request.state && failedRequest.current !== request) setPending([request]);
    else if (!fadingTo && pending[0]?.state === displayed.state) setPending(queue => queue.slice(1));
  }, [displayed, fadingTo, pending, request]);

  useEffect(() => {
    setHoldUntil(null);
    if (!active || displayedReady !== displayed) return;
    // Decode/load callbacks can precede paint. Cross two frame boundaries before
    // counting the readable interval, including initial and reduced-motion art.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => setHoldUntil(performance.now() + minimumPresenceMs));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, displayed, displayedReady]);

  useEffect(() => {
    if (!active || fadingTo || !incoming || ready !== incoming || (holdUntil === null && displayedReady === displayed)) return;
    const timer = window.setTimeout(() => setFadingTo(incoming), Math.max(0, (holdUntil ?? 0) - performance.now()));
    return () => window.clearTimeout(timer);
  }, [active, displayed, displayedReady, fadingTo, holdUntil, incoming, ready]);

  useEffect(() => {
    if (!active || !incoming || ready === incoming) return;
    // A broken image AND Rive file must not pin the presentation queue forever.
    // Retain painted outgoing pixels and allow the next valid activity to load.
    const timer = window.setTimeout(() => {
      failedRequest.current = incoming;
      setPending(queue => queue.filter(candidate => candidate !== incoming));
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [active, incoming, ready]);

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
      setHoldUntil(null);
      setDisplayed(fadingTo);
      setDisplayedReady(fadingTo);
      setPending(queue => queue.filter(candidate => candidate !== fadingTo));
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
          <OnePresencePlayback request={layer} presentation={presentation} onReady={handleReady} />
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
  const portraitSize = 1254;
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
    let posterDecoded = false;
    let decodingPoster = false;
    let notifiedRequest: PresenceRequest | null = null;
    let fallback = false;
    const paintProbe = document.createElement("canvas");
    paintProbe.width = paintProbe.height = 8;
    const probeContext = paintProbe.getContext("2d", { willReadFrequently: true });

    const notifyReady = () => {
      const next = onReadyRef.current;
      const painted = presented && canvas.style.visibility === "visible";
      // A decoded portrait is a complete presentation of this activity while
      // its larger Rive file loads. Waiting only for Rive can hide an entire
      // short-lived activity behind the previous pose on a slow connection.
      const posterReady = poster.style.visibility === "visible" && posterDecoded;
      if (!next.onReady || notifiedRequest === next.request || (!painted && !posterReady)) return;
      notifiedRequest = next.request;
      next.onReady(next.request);
    };
    notifyRef.current = notifyReady;

    const showPoster = () => {
      // Keep a painted frame frozen if the HD fallback is still loading.
      const usePoster = !presented || posterDecoded;
      canvas.style.visibility = usePoster ? "hidden" : "visible";
      poster.style.visibility = usePoster ? "visible" : "hidden";
    };
    const onPosterLoad = () => {
      if (!poster.complete || !poster.naturalWidth || posterDecoded || decodingPoster) return;
      decodingPoster = true;
      // In WebKit an async image can report complete before it is drawable.
      // Promote only decoded pixels, including for a cached portrait.
      const decoded = typeof poster.decode === "function" ? poster.decode() : Promise.resolve();
      void decoded.then(() => {
        decodingPoster = false;
        if (disposed) return;
        posterDecoded = true;
        if (fallback) showPoster();
        notifyReady();
      }, () => { decodingPoster = false; });
    };
    const canPlay = () => visible && !document.hidden && !motion.matches && appInteractionCoordinator.getLifecycleSnapshot().state === "active";
    const resizePlayback = () => {
      if (!instance || !ready) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      // Absorb fractional square bounds without clearing a painted buffer
      // when the same physical pixel budget still applies.
      const edge = Math.max(width, height);
      const target = Math.min(maxDrawingSurfaceSize, Math.ceil(edge * (window.devicePixelRatio || 1) - 0.001));
      const ratio = (target + 0.01) / edge;
      const pixelWidth = Math.min(maxDrawingSurfaceSize, Math.floor(width * ratio));
      const pixelHeight = Math.min(maxDrawingSurfaceSize, Math.floor(height * ratio));
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
            src: `/one-presence/hd/${state}.riv`,
            enableRiveAssetCDN: false,
            // Quantized native timelines change poses at 24 FPS; let Rive
            // skip bitmap redraws when no pose changed.
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
    onPosterLoad();
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
      <NextImage ref={posterRef} src={portrait[state]} alt="" width={portraitSize} height={portraitSize}
        unoptimized loading="eager" decoding="async" className="absolute inset-0 size-full object-contain" />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" style={{ visibility: "hidden" }} />
    </>
  );
}
