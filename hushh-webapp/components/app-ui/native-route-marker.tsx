"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Make sure you only have ONE interface block like this:
export interface NativeRouteMarkerProps {
  children?: ReactNode;
  className?: string;
  routeId: string;
  marker: string;
  // Combine all types into one line here
  authState: "authenticated" | "unauthenticated" | "loading" | "anonymous";
  dataState: "loaded" | "loading" | "error";
}

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