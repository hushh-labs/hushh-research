"use client";

import { useEffect, useEffectEvent } from "react";

type PrivacyBoundary = "blur" | "focus" | "hidden" | "pagehide" | "beforeprint";

/** Reduce accidental exposure; these events cannot detect or prevent screenshots. */
export function useSharedCardPrivacy(onBoundary: (boundary: PrivacyBoundary) => void) {
  const notify = useEffectEvent(onBoundary);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") notify("hidden");
    };
    const blur = () => notify("blur");
    const focus = () => notify("focus");
    const leave = () => notify("pagehide");
    const print = () => notify("beforeprint");
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
