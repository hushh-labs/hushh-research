"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { LiquidGlassRendererMode } from "@/lib/labs/liquid-glass-renderer";

const LiquidGlassRendererModeContext = createContext<LiquidGlassRendererMode>("mirror");

export function LiquidGlassRendererModeProvider({
  mode,
  children,
}: {
  mode: LiquidGlassRendererMode;
  children: ReactNode;
}) {
  return (
    <LiquidGlassRendererModeContext.Provider value={mode}>
      {children}
    </LiquidGlassRendererModeContext.Provider>
  );
}

export function useLiquidGlassRendererMode() {
  return useContext(LiquidGlassRendererModeContext);
}
