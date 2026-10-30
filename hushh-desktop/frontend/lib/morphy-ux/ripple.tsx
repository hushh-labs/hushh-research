"use client";

import { useRef, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { getRippleColor } from "./utils";

// ============================================================================
// RIPPLE PHYSICS ENGINE - Material 3 Expressive
// ============================================================================

export const rippleKeyframes = `
@keyframes ripple {
  0% {
    transform: translate(-50%, -50%) scale(0);
    opacity: 0.8;
  }
  40% {
    opacity: 0.6;
  }
  100% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 0;
  }
}

.animate-ripple {
  animation: ripple 600ms cubic-bezier(0.2, 0, 0.1, 1);
  will-change: transform, opacity;
  backface-visibility: hidden;
  transform: translateZ(0);
}
`;

// ============================================================================
// CSS INJECTION
// ============================================================================

const injectRippleStyles = () => {
  if (typeof window === "undefined") return;

  const rippleStyleId = "morphy-ripple-styles";
  if (!document.getElementById(rippleStyleId)) {
    const style = document.createElement("style");
    style.id = rippleStyleId;
    style.textContent = rippleKeyframes;
    document.head.appendChild(style);
  }
};

// ============================================================================
// RIPPLE EFFECT HOOK
// ============================================================================

export const useRipple = () => {
  const [ripple, setRipple] = useState<{
    x: number;
    y: number;
    size: number;
    id: number;
  } | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  // Inject styles when hook is used
  useEffect(() => {
    injectRippleStyles();
  }, []);

  const addRipple = (
    event: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Use actual mouse position relative to the element
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // Make ripple larger to flow through entire element
    const size = Math.max(rect.width, rect.height) * 2;

    const commit = () => {
      // Unique id forces remount → restarts CSS animation reliably
      setRipple({ x, y, size, id: Date.now() });
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current);
      }
      clearTimerRef.current = window.setTimeout(() => {
        setRipple(null);
        clearTimerRef.current = null;
      }, 650); // 50ms buffer after 600ms animation
    };

    // If a ripple is already active, clear it first, then start a new one next frame
    if (ripple) {
      setRipple(null);
      // Force next paint to ensure DOM removal before re-adding
      requestAnimationFrame(commit);
    } else {
      commit();
    }
  };

  const resetRipple = () => {
    if (clearTimerRef.current) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setRipple(null);
  };

  return { addRipple, resetRipple, ripple };
};

// ============================================================================
// RIPPLE COMPONENT
// ============================================================================

interface RippleProps {
  className?: string;
  children: React.ReactNode;
  [key: string]: unknown;
}

export const Ripple = ({ className, children, ...props }: RippleProps) => {
  const { addRipple, ripple } = useRipple();

  // Inject styles when component is used
  useEffect(() => {
    injectRippleStyles();
  }, []);

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      onMouseEnter={(e) => {
        // Trigger ripple only on enter
        addRipple(e);
      }}
      {...props}
    >
      {children}
      {ripple && (
        <span
          className={cn(
            "absolute rounded-full animate-ripple pointer-events-none",
            getRippleColor("gradient")
          )}
          style={{
            left: ripple.x,
            top: ripple.y,
            width: ripple.size,
            height: ripple.size,
            transform: "translate(-50%, -50%)",
          }}
        />
      )}
    </div>
  );
};
