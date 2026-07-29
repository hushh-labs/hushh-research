import { useState, useEffect } from "react";

/**
 * A highly robust hook that tracks the scroll progress (0 to 100) of the window
 * or any actively scrolling container within the application.
 * Uses event capturing to catch scroll events from any nested PWA containers.
 */
export function useScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let ticking = false;

    const handleScroll = (event: Event) => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          let scrollTop = 0;
          let scrollHeight = 0;
          let clientHeight = 0;

          // If the event target is the document/window
          if (event.target === document || event.target === window) {
            scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
            scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
            clientHeight = document.documentElement.clientHeight || window.innerHeight;
          } 
          // If the event target is a specific scrolling container (common in PWAs)
          else if (event.target instanceof HTMLElement) {
            scrollTop = event.target.scrollTop;
            scrollHeight = event.target.scrollHeight;
            clientHeight = event.target.clientHeight;
          }

          if (scrollHeight > clientHeight) {
            const currentProgress = (scrollTop / (scrollHeight - clientHeight)) * 100;
            setProgress(Math.min(100, Math.max(0, currentProgress)));
          } else {
            setProgress(0);
          }
          
          ticking = false;
        });
        ticking = true;
      }
    };

    // Use capture: true to intercept scroll events from any nested container before they bubble
    window.addEventListener("scroll", handleScroll, { passive: true, capture: true });

    // Initial check
    handleScroll({ target: document } as unknown as Event);

    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
    };
  }, []);

  return progress;
}
