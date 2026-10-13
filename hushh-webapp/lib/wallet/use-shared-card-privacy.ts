"use client";

import { useEffect, useRef } from "react";

type PrivacyBoundary = "blur" | "focus" | "hidden" | "pagehide" | "beforeprint";

/** Reduce accidental exposure; these events cannot detect or prevent screenshots. */
export function useSharedCardPrivacy(onBoundary: (boundary: PrivacyBoundary) => void) {
  const current = useRef(onBoundary);
  current.current = onBoundary;
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") current.current("hidden");
    };
    const blur = () => current.current("blur");
    const focus = () => current.current("focus");
    const leave = () => current.current("pagehide");
    const print = () => current.current("beforeprint");
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeprint", print);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeprint", print);
    };
  }, []);
}
