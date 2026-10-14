import { useEffect, useState } from "react";

/** Hydration starts on the still; hidden tabs and reduced motion stop playback. */
export function useMotionEnvironment(): boolean {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setAllowed(!query.matches && document.visibilityState === "visible");
    sync();
    query.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      query.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return allowed;
}
