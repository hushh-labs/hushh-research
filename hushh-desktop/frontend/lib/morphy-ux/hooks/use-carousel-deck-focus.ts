"use client";

import { useEffect, type MutableRefObject } from "react";
import { getGsap, prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import { ensureMorphyGsapReady, getMorphyEaseName } from "@/lib/morphy-ux/gsap-init";
import { getMotionCssVars } from "@/lib/morphy-ux/motion";

export function useCarouselDeckFocus(params: {
  activeIndex: number;
  slideEls: MutableRefObject<Array<HTMLElement | null>>;
  /**
   * Optional Embla API. If provided, we tween continuously during scroll/drag
   * so the deck effect feels smooth (not discrete per selected index).
   */
  api?: any;
}) {
  useEffect(() => {
    if (prefersReducedMotion()) return;

    const els = params.slideEls.current;
    if (!els.some(Boolean)) return;

    let cancelled = false;
    let revert: null | (() => void) = null;

    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap || cancelled) return;

      const { deckDurationMs, deckScales } = getMotionCssVars();
      const ease = getMorphyEaseName("emphasized");
      const scrollEase = getMorphyEaseName("decelerate");

      const smoothTo = (el: HTMLElement, vars: Record<string, unknown>) => {
        // Small interpolation window makes the deck feel fluid even if Embla scroll events are sparse.
        gsap.to(el, {
          ...vars,
          duration: Math.min(0.22, deckDurationMs / 1000),
          ease: scrollEase,
          overwrite: "auto",
        });
      };

      const tweenToIndex = () => {
        els.forEach((el, idx) => {
          if (!el) return;
          const dist = Math.abs(idx - params.activeIndex);
          const isActive = dist === 0;
          const isAdjacent = dist === 1;

          gsap.to(el, {
            scale: isActive
              ? deckScales.active
              : isAdjacent
                ? deckScales.adjacent
                : deckScales.other,
            opacity: isActive ? 1 : isAdjacent ? 0.72 : 0.55,
            y: isActive ? -4 : isAdjacent ? 2 : 4,
            zIndex: isActive ? 30 : isAdjacent ? 20 : 10,
            transformOrigin: "50% 50%",
            force3D: true,
            duration: deckDurationMs / 1000,
            ease,
            overwrite: "auto",
          } as unknown as Record<string, unknown>);
        });
      };

      const updateFromScroll = () => {
        const api = params.api;
        if (!api || typeof api.scrollProgress !== "function") {
          tweenToIndex();
          return;
        }

        const snaps: number[] =
          typeof api.scrollSnapList === "function" ? api.scrollSnapList() : [];
        const progress: number =
          typeof api.scrollProgress === "function" ? api.scrollProgress() : 0;

        const first = snaps[0] ?? 0;
        const last = snaps.length ? (snaps[snaps.length - 1] ?? first) : first;
        const span = snaps.length > 1 ? (last - first) / (snaps.length - 1) : 0.5;
        const activeSpan = deckScales.active - deckScales.other;
        const adjacentT =
          activeSpan !== 0
            ? (deckScales.adjacent - deckScales.other) / activeSpan
            : 0.2;
        const multiplier = span > 0 ? (1 - adjacentT) / span : 1.6;

        let bestIdx = 0;
        let bestT = -1;

        const tList = snaps.length ? snaps.map((s) => Math.max(0, 1 - Math.abs(s - progress) * multiplier)) : [];
        if (tList.length) {
          for (let i = 0; i < tList.length; i++) {
            if (tList[i]! > bestT) {
              bestT = tList[i]!;
              bestIdx = i;
            }
          }
        } else {
          bestIdx = params.activeIndex;
          bestT = 1;
        }

        els.forEach((el, idx) => {
          if (!el) return;
          const t = tList[idx] ?? (idx === params.activeIndex ? 1 : 0);

          // Scale uses linear t to match token mapping (adjacent lands near deckScales.adjacent).
          const scale = deckScales.other + activeSpan * t;
          // Opacity uses a softer curve so adjacent is more visible.
          const tOpacity = Math.pow(t, 0.6);
          const opacity = 0.18 + (1 - 0.18) * tOpacity;
          // Y uses slightly eased curve.
          const tY = Math.pow(t, 0.8);
          const y = 4 + (-4 - 4) * tY;

          const zIndex = idx === bestIdx ? 30 : t > 0.15 ? 20 : 10;

          smoothTo(el, {
            scale,
            opacity,
            y,
            zIndex,
            transformOrigin: "50% 50%",
            force3D: true,
          });
        });
      };

      if (gsap.context) {
        const scopeEl = els.find(Boolean) as HTMLElement | undefined;
        const ctx = gsap.context(() => {
          updateFromScroll();
        }, scopeEl);
        revert = () => ctx.revert();
      } else {
        updateFromScroll();
      }

      const api = params.api;
      if (api && typeof api.on === "function") {
        const onScroll = () => updateFromScroll();
        api.on("scroll", onScroll);
        api.on("reInit", onScroll);
        api.on("select", onScroll);

        revert = (() => {
          const prev = revert;
          return () => {
            try {
              api.off?.("scroll", onScroll);
              api.off?.("reInit", onScroll);
              api.off?.("select", onScroll);
            } catch {
              // ignore
            }
            prev?.();
          };
        })();
      }
    })();

    return () => {
      cancelled = true;
      revert?.();
    };
  }, [params.activeIndex, params.slideEls, params.api]);
}
