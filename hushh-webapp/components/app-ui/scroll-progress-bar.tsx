"use client";

import { useScrollProgress } from "@/lib/hooks/use-scroll-progress";

export function ScrollProgressBar() {
  const progress = useScrollProgress();

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-1 bg-transparent pointer-events-none">
      <div
        className="h-full bg-primary/80 backdrop-blur-sm transition-all duration-150 ease-out shadow-[0_0_10px_rgba(var(--primary),0.5)]"
        style={{
          width: `${progress}%`,
          opacity: progress > 0 ? 1 : 0,
        }}
      />
    </div>
  );
}
