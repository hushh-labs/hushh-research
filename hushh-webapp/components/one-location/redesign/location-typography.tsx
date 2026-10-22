"use client";

import { createContext, useContext, type ComponentType, type ReactNode } from "react";

const LocationTypographyContext = createContext(false);

type LocationTypographyContentProps = {
  className?: string;
  "data-location-type-scale"?: "connect";
  "data-location-type-context"?: "overlay" | "task" | "circle" | "flow";
  "data-profile-type-scale"?: string;
};

/** Presentation scope follows React portals without adding a layout box. */
export function LocationTypographyProvider({ children }: { children: ReactNode }) {
  return (
    <LocationTypographyContext.Provider value={true}>
      {children}
    </LocationTypographyContext.Provider>
  );
}

/**
 * Repeat the scope on the actual portal host. Task frames keep their local
 * typography tokens; explicit Circle content keeps its shared Profile roles.
 * Outside Location, the shared component receives its original props.
 */
export function withLocationTypography<P extends LocationTypographyContentProps>(
  Content: ComponentType<P>,
  profileTypeScale?: "circles",
) {
  return function LocationTypographyContent(props: P) {
    const active = useContext(LocationTypographyContext);
    if (!active) return <Content {...props} />;
    return (
      <Content
        {...props}
        data-location-type-scale="connect"
        data-location-type-context={
          props["data-location-type-context"] ??
          (profileTypeScale === "circles" ? "circle" : "overlay")
        }
        data-profile-type-scale={props["data-profile-type-scale"] ?? profileTypeScale}
      />
    );
  };
}
