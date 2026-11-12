"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Rive } from "@rive-app/canvas";
import NextImage from "next/image";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { fetchOnePresenceBytes, loadOnePresenceRuntime } from "@/lib/agent/one-presence-assets";
import { onePresenceFallback } from "./one-presence-fallback.generated";

export type OnePresenceState = "connected" | "thinking" | "working" | "answering";
type PresenceRequest = { state: OnePresenceState };
type Presentation = "compact" | "profile";

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

const profilePortrait = {
  connected: "/one-presence/profile-hd.png",
  working: "/one-presence/drafting-hd.png",
  thinking: "/one-presence/thinking-hd.png",
  answering: "/one-presence/answering-hd.png",
} satisfies Record<OnePresenceState, string>;

const fadeMs = 180;
const posterWaitMs = 150;
const loadDeadlineMs = 4500;
const retryDelayMs = 200;
const stateMachine = "State Machine 1";

// Only painted exports enter the cache. There are four assets per size and
// each canvas owns its own playback position.
const paintedAssets = new Map<string, ArrayBuffer>();

function usePresenceMotion(surfaceRef: React.RefObject<HTMLSpanElement | null>) {
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = typeof IntersectionObserver === "undefined";
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      setMotion(visible && !preference.matches && !document.hidden &&
        appInteractionCoordinator.getLifecycleSnapshot().state === "active");
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      visible = entries.at(-1)?.isIntersecting ?? false;
      sync();
    });
    observer?.observe(surface);
    const unsubscribe = appInteractionCoordinator.subscribeLifecycle(sync);
    preference.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      disposed = true;
      observer?.disconnect();
      unsubscribe();
      preference.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [surfaceRef]);
  return motion;
}

export function OnePresenceAvatar({ state, className, presentation = "compact" }: {
  state: OnePresenceState;
  className?: string;
  presentation?: Presentation;
}) {
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const motion = usePresenceMotion(surfaceRef);
  const [scene, setScene] = useState(() => ({ current: state, target: { state }, ready: false }));
  if (scene.target.state !== state) {
    setScene({ current: scene.current, target: { state }, ready: false });
  }
  const { current, target, ready } = scene;
  const changing = target.state !== current;
  const fading = changing && ready && motion;

  const markReady = useCallback((request: PresenceRequest) => {
    setScene(scene => scene.target === request && !scene.ready ? { ...scene, ready: true } : scene);
  }, []);

  useEffect(() => {
    if (!changing) return;
    const settle = () => setScene(scene => scene.target === target
      ? { current: target.state, target, ready: false }
      : scene);
    if (!motion) {
      settle();
      return;
    }
    // Prefer decoded artwork, but cap the time an old pose can remain on screen.
    // The incoming layer has its own embedded still if the poster is slow.
    const timer = ready
      ? window.setTimeout(settle, fadeMs)
      : window.setTimeout(() => markReady(target), posterWaitMs);
    return () => window.clearTimeout(timer);
  }, [changing, markReady, motion, ready, target]);

  return (
    <span ref={surfaceRef} aria-hidden="true" data-one-presence-state={state} className={`block relative isolate ${className ?? "size-11 shrink-0 md:size-18"}`}>
      {(changing ? [current, target.state] : [current]).map(pose => {
        const outgoing = pose === current;
        const latest = pose === target.state;
        return (
          <span key={pose} data-one-presence-artwork={pose} data-one-presence-layer={outgoing ? "current" : "incoming"}
            className="absolute inset-0 size-full"
            style={{
              mixBlendMode: fading ? "plus-lighter" : "normal",
              opacity: outgoing !== fading ? 1 : 0,
              transition: fading ? `opacity ${fadeMs}ms var(--motion-ease-decelerate, ease-out)` : undefined,
            }}>
            <OnePresencePlayback state={pose} presentation={presentation} play={motion && latest}
              holdFrame={motion && !latest} onReady={latest && changing ? () => markReady(target) : undefined} />
          </span>
        );
      })}
    </span>
  );
}

type PlaybackAttempt = {
  controller: AbortController;
  instance?: Rive;
  loaded: boolean;
  painted: boolean;
  bytes?: ArrayBuffer;
  deadline?: number;
};

function OnePresencePlayback({ state, presentation, play, holdFrame, onReady }: {
  state: OnePresenceState;
  presentation: Presentation;
  play: boolean;
  holdFrame: boolean;
  onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const posterRef = useRef<HTMLImageElement>(null);
  const fallbackRef = useRef<HTMLSpanElement>(null);
  const readyRef = useRef(onReady);
  const syncRef = useRef<((play: boolean, holdFrame: boolean) => void) | null>(null);
  useLayoutEffect(() => { readyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const poster = posterRef.current;
    const fallback = fallbackRef.current;
    if (!canvas || !poster || !fallback) return;

    const compact = presentation === "compact";
    const url = `/one-presence/${compact ? "compact" : "hd"}/${state}.riv`;
    const maxSurface = compact ? 320 : 768;
    let context: CanvasRenderingContext2D | null | undefined;
    let attempt: PlaybackAttempt | undefined;
    let failures = 0;
    let retryTimer: number | undefined;
    let paintFrame: number | undefined;
    let resizeFrame: number | undefined;
    let disposed = false;
    let shouldPlay = false;
    let keepFrame = false;
    let posterReady = false;
    let decodingPoster = false;
    let playing = false;

    const showArtwork = () => {
      const canvasVisible = Boolean(attempt?.painted && (shouldPlay || keepFrame || !posterReady));
      canvas.style.visibility = canvasVisible ? "visible" : "hidden";
      poster.style.visibility = !canvasVisible && posterReady ? "visible" : "hidden";
      fallback.style.visibility = canvasVisible || posterReady ? "hidden" : "visible";
    };

    const decodePoster = () => {
      if (decodingPoster || posterReady || !poster.complete || !poster.naturalWidth) return;
      decodingPoster = true;
      // WebKit can report a cached async image complete before it is drawable.
      const decoded = typeof poster.decode === "function" ? poster.decode() : Promise.resolve();
      void decoded.then(() => {
        if (disposed) return;
        posterReady = true;
        showArtwork();
        readyRef.current?.();
      }, () => {
        decodingPoster = false;
      });
    };

    const cancelPaint = () => {
      if (paintFrame !== undefined) window.cancelAnimationFrame(paintFrame);
      paintFrame = undefined;
    };

    const release = () => {
      const previous = attempt;
      attempt = undefined;
      playing = false;
      cancelPaint();
      window.clearTimeout(previous?.deadline);
      previous?.controller.abort();
      previous?.instance?.cleanup();
    };

    const fail = (candidate: PlaybackAttempt, status: string) => {
      if (attempt !== candidate) return;
      failures += 1;
      paintedAssets.delete(url);
      release();
      showArtwork();
      canvas.dataset.onePresencePlayback = status;
      if (shouldPlay && failures < 2) {
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          sync();
        }, retryDelayMs);
      }
    };

    const awaitPaint = (candidate: PlaybackAttempt) => {
      if (paintFrame !== undefined) return;
      canvas.dataset.onePresencePlayback = "waiting-for-paint";
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = undefined;
        if (attempt !== candidate || !shouldPlay) return;
        try {
          if (context === undefined) {
            const probe = document.createElement("canvas");
            probe.width = probe.height = 8;
            context = probe.getContext("2d", { willReadFrequently: true });
          }
          context?.clearRect(0, 0, 8, 8);
          context?.drawImage(canvas, 0, 0, 8, 8);
          const pixels = context?.getImageData(0, 0, 8, 8).data;
          if (!pixels?.some((alpha, index) => index % 4 === 3 && alpha > 0)) {
            awaitPaint(candidate);
            return;
          }
        } catch {
          fail(candidate, "paint-error");
          return;
        }
        candidate.painted = true;
        window.clearTimeout(candidate.deadline);
        candidate.deadline = undefined;
        if (candidate.bytes) paintedAssets.set(url, candidate.bytes);
        canvas.dataset.onePresencePlayback = "playing";
        showArtwork();
        readyRef.current?.();
      });
    };

    const sizeAndPlay = (candidate: PlaybackAttempt) => {
      const { instance } = candidate;
      if (!instance || !candidate.loaded) return;
      const { width, height } = canvas.getBoundingClientRect();
      const edge = Math.max(width, height);
      if (edge <= 0 || width <= 0 || height <= 0) return;
      // Only Rive resizes the backing buffer. Clearing it directly can consume
      // its next changed-frame draw and leave a transparent canvas.
      const target = Math.min(maxSurface, Math.ceil(edge * (window.devicePixelRatio || 1) - 0.001));
      const ratio = (target + 0.01) / edge;
      if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
        instance.resizeDrawingSurfaceToCanvas(ratio);
        candidate.painted = false;
        showArtwork();
      }
      if (!playing) {
        playing = true;
        instance.play(stateMachine);
      }
      if (candidate.painted) {
        canvas.dataset.onePresencePlayback = "playing";
        showArtwork();
      } else {
        candidate.deadline ??= window.setTimeout(() => fail(candidate, "paint-timeout"), loadDeadlineMs);
        awaitPaint(candidate);
      }
    };

    const start = () => {
      const candidate: PlaybackAttempt = { controller: new AbortController(), loaded: false, painted: false };
      attempt = candidate;
      candidate.deadline = window.setTimeout(() => fail(candidate, candidate.loaded ? "paint-timeout" : "load-timeout"), loadDeadlineMs);
      canvas.dataset.onePresencePlayback = "loading";
      const cached = paintedAssets.get(url);
      void Promise.all([
        loadOnePresenceRuntime(),
        cached ?? fetchOnePresenceBytes(url, candidate.controller.signal, failures ? "reload" : undefined),
      ]).then(([runtime, bytes]) => {
        if (attempt !== candidate) return;
        candidate.bytes = bytes;
        const instance = new runtime.Rive({
          canvas, buffer: bytes, enableRiveAssetCDN: false, stateMachine,
          shouldDisableRiveListeners: true, autoplay: false,
          layout: new runtime.Layout({ fit: runtime.Fit.Contain, alignment: runtime.Alignment.Center }),
          onLoad: () => {
            // Rive initializes its paused state machines after onLoad returns.
            queueMicrotask(() => {
              if (attempt !== candidate) return;
              candidate.loaded = true;
              instance.resizeToCanvas();
              sizeAndPlay(candidate);
            });
          },
          onLoadError: () => queueMicrotask(() => fail(candidate, "asset-error")),
        });
        candidate.instance = instance;
      }).catch(() => fail(candidate, "asset-error"));
    };

    const sync = () => {
      if (shouldPlay) {
        if (attempt) sizeAndPlay(attempt);
        else if (failures < 2 && retryTimer === undefined) start();
        return;
      }
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (attempt?.painted) {
        playing = false;
        attempt.instance?.pause(stateMachine);
        attempt.instance?.stopRendering();
      } else if (attempt) {
        release();
      }
      canvas.dataset.onePresencePlayback = "paused";
      showArtwork();
    };

    syncRef.current = (play, holdFrame) => {
      shouldPlay = play;
      keepFrame = holdFrame;
      sync();
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      // Run after the SDK's own resize observer, which can restore device DPR
      // after zero-size recovery. Preserve our presentation pixel budget.
      if (resizeFrame !== undefined) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (!disposed && shouldPlay) sync();
      });
    });
    resize?.observe(canvas);
    poster.addEventListener("load", decodePoster);
    decodePoster();
    return () => {
      disposed = true;
      syncRef.current = null;
      resize?.disconnect();
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      window.clearTimeout(retryTimer);
      poster.removeEventListener("load", decodePoster);
      release();
    };
  }, [presentation, state]);

  useEffect(() => { syncRef.current?.(play, holdFrame); }, [play, holdFrame, presentation, state]);

  const compact = presentation === "compact";
  return (
    <>
      <NextImage ref={posterRef} src={compact ? `/one-presence/compact/${state}.webp` : profilePortrait[state]}
        alt="" width={compact ? 320 : 1254} height={compact ? 320 : 1254}
        unoptimized loading="eager" decoding="async" className="absolute inset-0 size-full object-contain"
        style={{ visibility: "hidden" }} />
      <span ref={fallbackRef} className="absolute inset-0 bg-contain bg-center bg-no-repeat"
        data-one-presence-fallback="" style={{ backgroundImage: `url("${onePresenceFallback[state]}")` }} />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" style={{ visibility: "hidden" }} />
    </>
  );
}
