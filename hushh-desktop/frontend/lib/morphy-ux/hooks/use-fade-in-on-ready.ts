"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion, getGsap } from "@/lib/morphy-ux/gsap";
import { ensureMorphyGsapReady, getMorphyEaseName } from "@/lib/morphy-ux/gsap-init";
import { getMotionCssVars } from "@/lib/morphy-ux/motion";

const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function useFadeInOnReady(
  ref: RefObject<HTMLElement | null>,
  ready: boolean,
  opts?: { fromY?: number }
) {
  const hasPlayed = useRef(false);
  const fromY = opts?.fromY ?? 8;

  useIsoLayoutEffect(() => {
    if (!ready) {
      hasPlayed.current = false;
      return;
    }
    if (hasPlayed.current) return;
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el) return;

    hasPlayed.current = true;

    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap) return;
      const { durationsMs } = getMotionCssVars();

      gsap.fromTo(
        el,
        { opacity: 0, y: fromY },
        {
          opacity: 1,
          y: 0,
          duration: durationsMs.lg / 1000,
          ease: getMorphyEaseName("emphasized"),
          overwrite: "auto",
          clearProps: "opacity,transform",
        }
      );
    })();
  }, [ready, ref, fromY]);
}
