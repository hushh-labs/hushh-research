"use client";

/**
 * /test — from-scratch liquidglass reference harness.
 *
 * Replicates the library demo site (liquid-glass.ybouane.com) 1:1 so we can
 * compare our rendering against the author's reference under identical
 * conditions:
 *   - same background image (background-3.avif, served same-origin)
 *   - same DOM shape: root > img + bare glass <div>s (direct children)
 *   - same data-config values as the demo's three float panels + button
 *   - direct LiquidGlass.init, no coordinator, no app CSS beyond resets
 *
 * If glass renders correctly here but not on "/", the delta is in OUR page
 * conditions, not the library.
 */

import { useEffect, useRef } from "react";
import { LiquidGlass } from "@ybouane/liquidglass";

const PANELS = [
  // Exact configs from the demo site (site/index.html).
  { id: "regular", label: "Regular Glass", config: { floating: true, cornerRadius: 40, blurAmount: 0 } },
  { id: "frosted", label: "Frosted Glass", config: { floating: true, cornerRadius: 40, blurAmount: 0.5 } },
  { id: "dark", label: "Dark Glass", config: { floating: true, cornerRadius: 40, brightness: -0.3, blurAmount: 0.4 } },
] as const;

const BUTTON_CONFIG = { button: true, cornerRadius: 28, blurAmount: 0.3, brightness: -0.1 };

export default function LiquidGlassTestPage() {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let instance: { destroy(): void } | null = null;
    let cancelled = false;

    const start = async () => {
      const img = root.querySelector<HTMLImageElement>("img");
      if (img && !img.complete) {
        await new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      }
      if (cancelled) return;
      try {
        instance = await LiquidGlass.init({
          root,
          glassElements: root.querySelectorAll<HTMLElement>(".glass"),
        });
      } catch (err) {
        console.error("[/test] LiquidGlass init failed:", err);
      }
    };

    void start();
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100dvh",
        overflow: "hidden",
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif",
      }}
    >
      {/* Background image: direct child sibling, engine fast path. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/liquid-glass-test-bg.avif"
        alt=""
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          pointerEvents: "none",
        }}
      />

      {/* Three demo float panels: bare divs, transparent, label above canvas. */}
      {PANELS.map((panel, i) => (
        <div
          key={panel.id}
          className="glass"
          data-config={JSON.stringify(panel.config)}
          style={{
            position: "absolute",
            width: 220,
            height: 110,
            top: `${22 + i * 24}%`,
            left: `${12 + i * 26}%`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 3,
          }}
        >
          <span
            style={{
              position: "relative",
              zIndex: 2,
              pointerEvents: "none",
              color: "#fff",
              fontWeight: 800,
              fontSize: 22,
              textShadow: "0 1px 4px rgba(0,0,0,0.3)",
            }}
          >
            {panel.label}
          </span>
        </div>
      ))}

      {/* Demo button-mode pill. */}
      <button
        type="button"
        className="glass"
        data-config={JSON.stringify(BUTTON_CONFIG)}
        style={{
          position: "absolute",
          bottom: "10%",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "14px 28px",
          border: 0,
          background: "transparent",
          color: "#fff",
          fontWeight: 600,
          fontSize: 16,
          zIndex: 3,
          cursor: "pointer",
        }}
      >
        <span style={{ position: "relative", zIndex: 2, pointerEvents: "none" }}>
          Click Me
        </span>
      </button>
    </div>
  );
}
