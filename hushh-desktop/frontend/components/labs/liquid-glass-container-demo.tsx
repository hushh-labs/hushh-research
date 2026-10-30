"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

export function LiquidGlassContainerDemo() {
  const [useImageBg, setUseImageBg] = useState(false);

  return (
    <section className="space-y-5">
      <div
        className={cn(
          "relative -ml-4 flex h-96 w-[calc(100%+32px)] items-center justify-center overflow-hidden rounded-xl border border-black/10 text-black/5 dark:border-white/10 dark:text-white/5",
          useImageBg ? "animate-bg-pan" : ""
        )}
        style={
          useImageBg
            ? {
                backgroundImage:
                  'url("https://images.unsplash.com/photo-1651784627380-58168977f4f9?q=80&w=987&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D")',
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : {
                backgroundImage:
                  "linear-gradient(to right, currentColor 1px, transparent 1px),linear-gradient(to bottom, currentColor 1px, transparent 1px),radial-gradient(120% 100% at 10% 0%, var(--bg1), var(--bg2))",
                backgroundSize: "24px 24px, 24px 24px, 100% 100%",
                backgroundPosition: "12px 12px, 12px 12px, 0 0",
              }
        }
      >
        {useImageBg ? (
          <a
            href="https://unsplash.com/@visaxslr"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute left-3 top-3 inline-block text-[9px] uppercase tracking-wider text-white/40"
          >
            Photo by @visaxslr
            <br />
            on Unsplash
          </a>
        ) : null}

        <div className="z-10 flex h-full w-full flex-col justify-center px-8">
          <div className="grid h-64 grid-cols-2 gap-6 overflow-y-auto overflow-x-hidden">
            <LiquidGlassContainerPanel>
              <div className="flex h-full flex-col text-white">
                <h3 className="text-lg font-bold">Glass Card</h3>
                <p className="text-sm opacity-80">Responsive container with blurred edge treatment.</p>
                <p className="text-sm opacity-80">Content remains independent from the glass shell.</p>
                <p className="text-sm opacity-80">This mirrors the Vue demo structure without leaking into app chrome.</p>
                <div className="mt-4 flex h-[4.5rem] w-full items-center justify-between rounded-[1.5rem] border border-white/10 bg-black/55 p-3">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <div key={index} className="h-12 w-12 rounded-xl bg-white/10" />
                  ))}
                </div>
              </div>
            </LiquidGlassContainerPanel>
            <LiquidGlassContainerPanel>
              <div className="flex h-full items-center justify-center text-white">
                <span className="text-2xl font-bold">Centered Content</span>
              </div>
            </LiquidGlassContainerPanel>
          </div>
        </div>

        <label className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md px-2 py-1 text-xs backdrop-blur">
          <input
            type="checkbox"
            checked={useImageBg}
            onChange={(event) => setUseImageBg(event.target.checked)}
            className="accent-blue-600"
          />
          <span className={useImageBg ? "text-white/90" : "text-black/90 dark:text-white/90"}>
            Use image background
          </span>
        </label>
      </div>
    </section>
  );
}

function LiquidGlassContainerPanel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-[3rem]"
      style={{
        border: "1.5px solid rgb(112 112 112 / 38%)",
        backgroundColor: "rgba(255,255,255,0.12)",
        boxShadow: "0 4px 20px rgba(0, 0, 0, 0.24)",
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white/28 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/20 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-white/18 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-black/12 to-transparent" />
      <div className="absolute inset-[40px] rounded-[2rem] backdrop-blur-[3px]" />
      <div className="absolute inset-0 z-[1] h-full w-full overflow-auto p-5">{children}</div>
    </div>
  );
}
