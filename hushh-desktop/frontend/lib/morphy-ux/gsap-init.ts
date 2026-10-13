"use client";

import { getGsap } from "./gsap";
import { getMotionCssVars, type MotionEasingKey } from "./motion";

let initPromise: Promise<void> | null = null;
let hasCustomEase = false;

function cssBezierToCustomEaseSpec(input: string): string | null {
  const v = input.trim();
  // Accept "0.2,0,0,1"
  if (/^[0-9.\s,]+$/.test(v)) return v.replace(/\s+/g, "");
  const m = v.match(/cubic-bezier\(\s*([^)]+)\s*\)/i);
  if (!m) return null;
  const captured = m[1];
  if (!captured) return null;
  const parts = captured
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 4) return null;
  return parts.join(",");
}

export async function ensureMorphyGsapReady(): Promise<void> {
  if (typeof window === "undefined") return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const gsap = await getGsap();
    if (!gsap) return;

    // Try CustomEase (preferred) but allow graceful fallback.
    try {
      const ce = await import("gsap/CustomEase");
      const CustomEase: any = (ce as any).CustomEase ?? (ce as any).default ?? ce;
      if (gsap.registerPlugin && CustomEase) {
        gsap.registerPlugin(CustomEase);
      }
      if (CustomEase?.create) {
        const { easings } = getMotionCssVars();
        (Object.keys(easings) as MotionEasingKey[]).forEach((k) => {
          const spec = cssBezierToCustomEaseSpec(easings[k]) ?? "0.2,0,0,1";
          try {
            CustomEase.create(`morphy-${k}`, spec);
          } catch {
            // If creation fails, we still have gsap parsing cubic-bezier strings.
          }
        });
        hasCustomEase = true;
      }
    } catch {
      // ignore: built-in "cubic-bezier(...)" easing strings are supported by GSAP.
      hasCustomEase = false;
    }
  })();

  return initPromise;
}

export function getMorphyEaseName(key: MotionEasingKey): string {
  // When CustomEase is available, prefer stable IDs; otherwise, pass the CSS cubic-bezier directly.
  if (hasCustomEase) return `morphy-${key}`;
  const { easings } = getMotionCssVars();
  return easings[key] ?? "power3.out";
}
