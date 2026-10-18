"use client";

import { useEffect, useMemo, useRef, type SVGProps } from "react";
import { weaveFrame, WEAVE_DURATION_MS } from "./weave-geometry";

/** Approved Weave motion; frames update the SVG without rerendering its row. */
export function ConnectorsShortcutIcon({ style, ...props }: SVGProps<SVGSVGElement>) {
  const glyphRef = useRef<SVGGElement>(null);

  // React leaves this imperative subtree intact when the surrounding app rerenders.
  const artwork = useMemo(() => <g ref={glyphRef} dangerouslySetInnerHTML={{ __html: weaveFrame() }} />, []);

  useEffect(() => {
    const glyph = glyphRef.current;
    const trigger = glyph?.closest("button");
    if (!glyph || !trigger) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start: number | null = null;
    let playing = false;
    let phase = 0;

    const paint = (progress: number) => { glyph.innerHTML = weaveFrame(progress, phase); };
    const cancel = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      start = null;
      playing = false;
      trigger.removeAttribute("data-shortcut-icon-playing");
      paint(0);
    };
    const step = (now: number) => {
      if (start === null) start = now;
      const progress = (now - start) / WEAVE_DURATION_MS;
      if (progress >= 1) {
        // A quarter-turn maps loop i onto resting loop i+1. Carry its colour
        // forward so the final frame and next resting/replay frame are equal.
        phase = (phase + 1) % 4;
        cancel();
        return;
      }
      paint(progress);
      frame = requestAnimationFrame(step);
    };
    const play = () => {
      if (playing || trigger.disabled || reduced.matches || document.hidden) return;
      playing = true;
      trigger.setAttribute("data-shortcut-icon-playing", "true");
      frame = requestAnimationFrame(step);
    };
    const pointerEnter = (event: PointerEvent) => { if (event.pointerType !== "touch") play(); };
    const focus = () => { if (trigger.matches(":focus-visible")) play(); };
    const preference = () => { if (reduced.matches) cancel(); };
    const visibility = () => { if (document.hidden) cancel(); };
    trigger.addEventListener("pointerenter", pointerEnter);
    trigger.addEventListener("focus", focus);
    trigger.addEventListener("click", play, true);
    reduced.addEventListener("change", preference);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancel();
      trigger.removeEventListener("pointerenter", pointerEnter);
      trigger.removeEventListener("focus", focus);
      trigger.removeEventListener("click", play, true);
      reduced.removeEventListener("change", preference);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return <svg
    width="24" height="24" viewBox="0 0 32 32" fill="none"
    {...props}
    style={{ ...style, overflow: "visible" }}
  >{artwork}</svg>;
}
