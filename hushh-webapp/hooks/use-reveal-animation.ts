"use client";

import { useEffect, useRef } from "react";
import { getGsap, prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import { motionDefaults, motionVariants } from "@/lib/morphy-ux/motion";

type RevealDirection = "up" | "down" | "none";

interface UseRevealAnimationOptions {
  delay?: number;
  duration?: number;
  direction?: RevealDirection;
  threshold?: number;
}

/**
 * A hook that adds a GSAP reveal animation to an element when it mounts or enters view.
 * Designed for "Impact" UI polish following Morphy/Material 3 expressive standards.
 */
export function useRevealAnimation<T extends HTMLElement>({
  delay = 0,
  duration = motionDefaults.durationMs / 1000,
  direction = "up",
}: UseRevealAnimationOptions = {}) {
  const elementRef = useRef<T>(null);

  useEffect(() => {
    let cancelled = false;

    async function initAnimation() {
      if (prefersReducedMotion()) return;
      
      const gsap = await getGsap();
      if (!gsap || cancelled || !elementRef.current) return;

      const variant = direction === "up" 
        ? motionVariants.enterFromBottom 
        : direction === "down" 
        ? { y: -motionVariants.enterFromBottom.y, opacity: motionVariants.enterFromBottom.opacity }
        : motionVariants.fadeIn;

      gsap.fromTo(
        elementRef.current,
        {
          ...variant,
        },
        {
          y: 0,
          opacity: 1,
          duration,
          delay,
          ease: "power3.out",
          overwrite: "auto",
        }
      );
    }

    void initAnimation();

    return () => {
      cancelled = true;
    };
  }, [delay, direction, duration]);

  return elementRef;
}
