"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";
import { prefersReducedMotion, getGsap } from "@/lib/morphy-ux/gsap";
import { ensureMorphyGsapReady, getMorphyEaseName } from "@/lib/morphy-ux/gsap-init";
import { getMotionCssVars } from "@/lib/morphy-ux/motion";

const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

const AUTO_FADE_DATASET_KEY = "gsapAutoFadeReady";
const AUTO_FADE_MAX_TARGETS = 140;

function collectFadeTargets(root: HTMLElement): HTMLElement[] {
  const candidates: HTMLElement[] = [root];

  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLElement) {
      candidates.push(child);
    }
  }

  const semanticNodes = root.querySelectorAll<HTMLElement>(
    "[data-slot], [data-card], section, article, [role='region'], [role='dialog'], table, ul, ol, [class*='card'], [class*='view'], [class*='chart']"
  );
  for (const node of semanticNodes) {
    candidates.push(node);
  }

  const deduped: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const node of candidates) {
    if (seen.has(node)) continue;
    seen.add(node);
    if ((node.dataset as Record<string, string | undefined>)[AUTO_FADE_DATASET_KEY] === "1") continue;
    if (node.classList.contains("animate-none")) continue;
    deduped.push(node);
    (node.dataset as Record<string, string | undefined>)[AUTO_FADE_DATASET_KEY] = "1";
    if (deduped.length >= AUTO_FADE_MAX_TARGETS) break;
  }
  return deduped;
}

export function usePageEnterAnimation(
  ref: RefObject<HTMLElement | null>,
  opts?: { enabled?: boolean; key?: string; observeMutations?: boolean }
) {
  const enabled = opts?.enabled ?? true;
  const key = opts?.key;
  const observeMutations = opts?.observeMutations ?? true;

  useIsoLayoutEffect(() => {
    if (!enabled) return;
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el) return;

    let revert: null | (() => void) = null;
    let observer: MutationObserver | null = null;
    let cancelled = false;

    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap || cancelled) return;
      const { pageEnterDurationMs } = getMotionCssVars();
      const initialTargets = collectFadeTargets(el);

      // Use gsap.context when available so animations are scoped and safely reverted.
      if (gsap.context) {
        const ctx = gsap.context(() => {
          if (initialTargets.length > 0) {
            gsap.fromTo(
              initialTargets,
              { opacity: 0, y: 8 },
              {
                opacity: 1,
                y: 0,
                duration: pageEnterDurationMs / 1000,
                stagger: 0.014,
                ease: getMorphyEaseName("emphasized"),
                overwrite: "auto",
                clearProps: "opacity,transform",
              }
            );
          } else {
            gsap.fromTo(
              el,
              { opacity: 0, y: 8 },
              {
                opacity: 1,
                y: 0,
                duration: pageEnterDurationMs / 1000,
                ease: getMorphyEaseName("emphasized"),
                overwrite: "auto",
                clearProps: "opacity,transform",
              }
            );
          }
        }, el);
        revert = () => ctx.revert();
      } else {
        // Fallback: just run the tween.
        gsap.fromTo(
          el,
          { opacity: 0, y: 8 },
          {
            opacity: 1,
            y: 0,
            duration: pageEnterDurationMs / 1000,
            ease: getMorphyEaseName("emphasized"),
            overwrite: "auto",
            clearProps: "opacity,transform",
          }
        );
      }

      if (observeMutations) {
        // Routes that mount a loader first (profile, marketplace, any
        // cache-cold screen) stream their REAL content in via mutations. The
        // first substantial batch after a route change must play the SAME
        // full staggered enter as synchronously-rendered routes (/one/kai),
        // otherwise those tabs feel like a different, cheaper transition.
        // Subsequent streams (pagination, live updates) keep the quick tween.
        let firstContentBatch = true;
        observer = new MutationObserver((records) => {
          const added: HTMLElement[] = [];
          for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
              if (!(node instanceof HTMLElement)) continue;
              if (node.closest("[data-no-auto-fade='true']")) continue;
              for (const target of collectFadeTargets(node)) {
                added.push(target);
                if (added.length >= AUTO_FADE_MAX_TARGETS) break;
              }
              if (added.length >= AUTO_FADE_MAX_TARGETS) break;
            }
            if (added.length >= AUTO_FADE_MAX_TARGETS) break;
          }
          if (added.length === 0) return;
          const fullEnter = firstContentBatch;
          firstContentBatch = false;
          gsap.fromTo(
            added,
            { opacity: 0, y: fullEnter ? 8 : 6 },
            {
              opacity: 1,
              y: 0,
              duration: fullEnter
                ? pageEnterDurationMs / 1000
                : Math.max(0.18, pageEnterDurationMs / 1400),
              stagger: fullEnter ? 0.014 : 0.01,
              ease: getMorphyEaseName("emphasized"),
              overwrite: "auto",
              clearProps: "opacity,transform",
            }
          );
        });
        observer.observe(el, { childList: true, subtree: true });
      }
    })();

    return () => {
      cancelled = true;
      if (observer) {
        observer.disconnect();
      }
      revert?.();
    };
  }, [enabled, observeMutations, ref, key]);
}
