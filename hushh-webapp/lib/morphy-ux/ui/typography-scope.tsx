"use client";

import { createContext, useContext, type ReactNode } from "react";

const TypographyScopeContext = createContext<string | undefined>(undefined);

/** Carries an opted-in typography class across React portals. */
export function TypographyScopeProvider({ className, children }: { className?: string; children: ReactNode }) {
  return <TypographyScopeContext.Provider value={className}>{children}</TypographyScopeContext.Provider>;
}

export function useTypographyScope() {
  return useContext(TypographyScopeContext);
}
