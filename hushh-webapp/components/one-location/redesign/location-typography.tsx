"use client";

import { createContext, useContext, type ComponentType, type ReactNode } from "react";

const LocationTypographyContext = createContext(false);

/** Presentation scope follows React portals without changing their ownership. */
export function LocationTypographyProvider({ children }: { children: ReactNode }) {
  return (
    <LocationTypographyContext.Provider value={true}>
      {children}
    </LocationTypographyContext.Provider>
  );
}

/** Shared Circle surfaces keep their existing type when opened outside Location. */
export function withLocationTypography<P extends { className?: string }>(
  Content: ComponentType<P>,
) {
  return function LocationTypographyContent(props: P) {
    const active = useContext(LocationTypographyContext);
    return <Content {...props} data-location-type-scale={active ? "connect" : undefined} />;
  };
}
