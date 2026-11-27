"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_STREAM_RENDER_FRAME_MS = 16;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function clampSafeCodePointBoundary(target: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= target.length) return target.length;
  const prev = target.charCodeAt(index - 1);
  const next = target.charCodeAt(index);
  if (isHighSurrogate(prev) && isLowSurrogate(next)) {
    return index + 1;
  }
  return index;
}

export function advanceToNaturalWordBoundary(
  target: string,
  currentLen: number,
  rawStep: number,
): number {
  const desiredEnd = clampSafeCodePointBoundary(
    target,
    Math.min(target.length, currentLen + rawStep),
  );
  if (desiredEnd >= target.length) return target.length;

  // Snap forward up to 10 chars to include a trailing space/newline so whole
  // words and inline markdown tokens appear coherently without mid-glyph jitter.
  const lookaheadLimit = Math.min(target.length, desiredEnd + 10);
  for (let i = desiredEnd; i < lookaheadLimit; i += 1) {
    const ch = target.charCodeAt(i);
    if (ch === 32 || ch === 10 || ch === 9) {
      return clampSafeCodePointBoundary(target, i + 1);
    }
  }

  // Avoid slicing right inside a paired inline markdown marker (`**`, `` ` ``, `~~`)
  // when the next character is already buffered in target.
  let safeEnd = desiredEnd;
  while (
    safeEnd < target.length &&
    safeEnd - desiredEnd < 3 &&
    (target.charCodeAt(safeEnd - 1) === 42 ||
      target.charCodeAt(safeEnd - 1) === 96 ||
      target.charCodeAt(safeEnd - 1) === 126)
  ) {
    safeEnd += 1;
  }
  return clampSafeCodePointBoundary(target, safeEnd);
}

export function useAnimatedStreamText(
  targetText: string,
  active: boolean,
  frameMs = DEFAULT_STREAM_RENDER_FRAME_MS,
) {
  const [displayedText, setDisplayedText] = useState(() => {
    if (!active || !targetText) return active ? "" : targetText;
    return targetText.slice(0, advanceToNaturalWordBoundary(targetText, 0, 24));
  });
  const [tailSettling, setTailSettling] = useState(false);
  const displayedTextRef = useRef(displayedText);
  const targetTextRef = useRef(targetText);
  const activeRef = useRef(active);
  const frameRef = useRef(0);
  const lastPaintAtRef = useRef(0);

  useEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    targetTextRef.current = targetText;

    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!active) {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      lastPaintAtRef.current = 0;
      const hadRemainingTail =
        wasActive &&
        !reducedMotion &&
        displayedTextRef.current.length < targetText.length;
      displayedTextRef.current = targetText;
      setDisplayedText(targetText);
      if (hadRemainingTail) {
        setTailSettling(true);
        const timer = window.setTimeout(() => setTailSettling(false), 160);
        return () => window.clearTimeout(timer);
      }
      return undefined;
    }

    if (
      reducedMotion ||
      (typeof document !== "undefined" && document.visibilityState === "hidden")
    ) {
      displayedTextRef.current = targetText;
      setDisplayedText(targetText);
      return undefined;
    }

    // Zero artificial TTFT lag: paint the opening word/phrase immediately on
    // arrival, then glide at 60fps for subsequent chunks.
    if (displayedTextRef.current.length === 0 && targetText.length > 0) {
      const initialEnd = advanceToNaturalWordBoundary(targetText, 0, 24);
      const initialText = targetText.slice(0, initialEnd);
      displayedTextRef.current = initialText;
      setDisplayedText(initialText);
      lastPaintAtRef.current =
        typeof performance !== "undefined" ? performance.now() : 0;
    } else if (!targetText.startsWith(displayedTextRef.current)) {
      displayedTextRef.current = targetText;
      setDisplayedText(targetText);
    }

    if (
      frameRef.current === 0 &&
      displayedTextRef.current.length < targetText.length
    ) {
      const tick = (now: number) => {
        if (!activeRef.current) {
          frameRef.current = 0;
          return;
        }
        const target = targetTextRef.current;
        const current = displayedTextRef.current;

        if (!target.startsWith(current)) {
          displayedTextRef.current = target;
          setDisplayedText(target);
          frameRef.current = 0;
          return;
        }

        if (current.length >= target.length) {
          frameRef.current = 0;
          lastPaintAtRef.current = 0;
          return;
        }

        if (
          lastPaintAtRef.current &&
          now - lastPaintAtRef.current < frameMs
        ) {
          frameRef.current = window.requestAnimationFrame(tick);
          return;
        }

        const elapsedMs = lastPaintAtRef.current
          ? Math.min(48, Math.max(12, now - lastPaintAtRef.current))
          : frameMs;
        lastPaintAtRef.current = now;

        const backlog = target.length - current.length;
        // Continuous proportional velocity curve: smooth 60fps flow with zero cliff jumps.
        const charsPerSecond = Math.min(
          4200,
          Math.max(520, 480 + backlog * 9.5),
        );
        const rawStep = Math.max(
          1,
          Math.min(backlog, Math.ceil((charsPerSecond * elapsedMs) / 1000)),
        );
        const nextEnd = advanceToNaturalWordBoundary(
          target,
          current.length,
          rawStep,
        );
        const nextText = target.slice(0, nextEnd);
        displayedTextRef.current = nextText;
        setDisplayedText(nextText);

        if (nextText.length < targetTextRef.current.length) {
          frameRef.current = window.requestAnimationFrame(tick);
        } else {
          frameRef.current = 0;
        }
      };

      frameRef.current = window.requestAnimationFrame(tick);
    }

    return undefined;
  }, [active, frameMs, targetText]);

  useEffect(() => {
    return () => {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, []);

  return {
    displayedText: active ? displayedText : targetText,
    isAnimating: active,
    tailSettling,
  };
}
