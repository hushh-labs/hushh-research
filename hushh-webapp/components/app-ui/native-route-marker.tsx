"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// 1. Add the missing properties to the interface
export interface NativeRouteMarkerProps {
  children?: ReactNode;
  className?: string;
  routeId: string;
  marker: string;
  authState: "authenticated" | "unauthenticated" | "loading";
  dataState: "loaded" | "loading" | "error";
}

// 2. Accept these props in the component
export function NativeRouteMarker({ 
  children, 
  className,
  routeId,
  marker,
  authState,
  dataState
}: NativeRouteMarkerProps) {
  return (
    <div className={cn("hidden", className)} data-route={routeId} data-marker={marker}>
      {children}
    </div>
  );
}

NativeRouteMarker.displayName = "NativeRouteMarker";