"use client";

import { useEffect, useLayoutEffect } from "react";
import type { MutableRefObject } from "react";

import { getGsap, prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import {
  ensureMorphyGsapReady,
  getMorphyEaseName,
} from "@/lib/morphy-ux/gsap-init";
import { getMotionCssVars } from "@/lib/morphy-ux/motion";

type RailRefs = {
  activeLineEl: MutableRefObject<HTMLElement | null>;
  topDotEl: MutableRefObject<HTMLElement | null>;
  bottomDotEl: MutableRefObject<HTMLElement | null>;
};

type RunFeatureRailTrailAnimationParams = {
  enabled: boolean;
  railRefs: RailRefs;
  chipRefs: MutableRefObject<Array<HTMLElement | null>>;
};

const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function setFinalActiveState(
  lineEl: HTMLElement | null,
  topDotEl: HTMLElement | null,
  bottomDotEl: HTMLElement | null,
  chips: HTMLElement[]
) {
  if (lineEl) {
    lineEl.style.transformOrigin = "50% 0%";
    lineEl.style.transform = "scaleY(1)";
  }
  if (topDotEl) {
    topDotEl.dataset.state = "active";
    topDotEl.style.opacity = "1";
  }
  if (bottomDotEl) {
    bottomDotEl.dataset.state = "active";
    bottomDotEl.style.opacity = "1";
  }
  chips.forEach((chip) => {
    chip.dataset.state = "active";
    chip.style.opacity = "1";
    chip.style.transform = "translate3d(0,0,0)";
  });
}

export async function runFeatureRailTrailAnimation({
  enabled,
  railRefs,
  chipRefs,
}: RunFeatureRailTrailAnimationParams): Promise<(() => void) | undefined> {
  const lineEl = railRefs.activeLineEl.current;
  const topDotEl = railRefs.topDotEl.current;
  const bottomDotEl = railRefs.bottomDotEl.current;
  const chips = chipRefs.current.filter(
    (node): node is HTMLElement => Boolean(node)
  );

  if (!enabled || !lineEl || !topDotEl || !bottomDotEl || chips.length === 0) {
    setFinalActiveState(lineEl, topDotEl, bottomDotEl, chips);
    return;
  }

  if (typeof window === "undefined" || prefersReducedMotion()) {
    setFinalActiveState(lineEl, topDotEl, bottomDotEl, chips);
    return;
  }

  await ensureMorphyGsapReady();
  const gsap = await getGsap();
  if (!gsap) {
    setFinalActiveState(lineEl, topDotEl, bottomDotEl, chips);
    return;
  }

  const { durationsMs } = getMotionCssVars();
  const ease = getMorphyEaseName("emphasized");
  const settleEase = getMorphyEaseName("decelerate");
  const chipEase = getMorphyEaseName("emphasized");
  const scope = lineEl.closest("[data-feature-rail-list='true']") ?? lineEl;

  if ((gsap as any).killTweensOf) {
    (gsap as any).killTweensOf([lineEl, topDotEl, bottomDotEl, ...chips]);
  }

  const run = () => {
    const setNow = gsap.set
      ? gsap.set.bind(gsap)
      : (target: unknown, vars: Record<string, unknown>) =>
          gsap.to(target, { ...vars, duration: 0, overwrite: "auto" });

    setNow([topDotEl, bottomDotEl], { opacity: 0.35 });
    setNow(lineEl, { scaleY: 0, transformOrigin: "50% 0%" });
    chips.forEach((chip) => {
      chip.dataset.state = "muted";
    });
    setNow(chips, { opacity: 0.72, y: 6 });

    const startDelay = Math.max(durationsMs.lg / 1000, 0.45);
    const lineDelay = startDelay + durationsMs.sm / 1000;
    const lineDuration = Math.max((durationsMs.xxl * 1.45) / 1000, 1.8);
    const chipDuration = Math.max(durationsMs.xl / 1000, 0.5);
    const timeline = (gsap as any).timeline?.({ defaults: { overwrite: "auto" } });

    if (!timeline) {
      setFinalActiveState(lineEl, topDotEl, bottomDotEl, chips);
      return;
    }

    timeline.to(
      topDotEl,
      {
        opacity: 1,
        duration: durationsMs.sm / 1000,
        ease: settleEase,
        onStart: () => {
          topDotEl.dataset.state = "active";
        },
      },
      startDelay
    );

    timeline.to(
      lineEl,
      {
        scaleY: 1,
        duration: lineDuration,
        ease,
      },
      lineDelay
    );

    chips.forEach((chip, index) => {
      const progress = chips.length === 1 ? 0.5 : index / (chips.length - 1);
      const lineProgress = 0.12 + progress * 0.76;
      const at = lineDelay + lineDuration * lineProgress;
      timeline.to(
        chip,
        {
          opacity: 1,
          y: 0,
          duration: chipDuration,
          ease: chipEase,
          onStart: () => {
            chip.dataset.state = "active";
          },
        },
        at
      );
    });

    timeline.to(
      bottomDotEl,
      {
        opacity: 1,
        duration: durationsMs.sm / 1000,
        ease: settleEase,
        onStart: () => {
          bottomDotEl.dataset.state = "active";
        },
      },
      lineDelay + lineDuration
    );
  };

  if (gsap.context) {
    const ctx = gsap.context(run, scope);
    return () => ctx.revert();
  }

  run();
  return;
}

export function useFeatureRailTrail({
  enabled,
  railRefs,
  chipRefs,
}: RunFeatureRailTrailAnimationParams) {
  useIsoLayoutEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void runFeatureRailTrailAnimation({ enabled, railRefs, chipRefs }).then(
      (dispose) => {
        if (cancelled) {
          dispose?.();
          return;
        }
        cleanup = dispose;
      }
    );

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [
    enabled,
    railRefs.activeLineEl,
    railRefs.topDotEl,
    railRefs.bottomDotEl,
    chipRefs,
  ]);
}
