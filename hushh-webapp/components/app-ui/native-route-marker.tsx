import type { CSSProperties } from "react";

// =============================================================================
// TYPE CONSTRAINTS SCHEMAS (Enforcing domain type safety over raw strings)
// =============================================================================

export type NativeAuthTelemetryState = 
  | "public" 
  | "authenticated" 
  | "vault-unlocked" 
  | "mfa-pending" 
  | "anonymous";

export type NativeDataTelemetryState = 
  | "idle" 
  | "loading" 
  | "loaded" 
  | "empty-valid" 
  | "stale-fallback" 
  | "error-upstream"
  | "error"; // Added to maintain backward compatibility with legacy views

export interface NativeRouteMarkerProps {
  routeId: string;
  marker: string;
  authState?: NativeAuthTelemetryState;
  dataState?: NativeDataTelemetryState;
  metadata?: Record<string, unknown>; // Feature: Structured diagnostic metadata serialization
}

// Reusable invisible configuration layout block
const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  display: "none",
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  border: 0,
};

// =============================================================================
// CANONICAL COMPONENT NODE (React Server Component)
// =============================================================================

export function NativeRouteMarker({
  routeId,
  marker,
  authState = "anonymous",
  dataState = "idle",
  metadata,
}: NativeRouteMarkerProps) {
  
  // Safely stringify custom payloads for automated E2E test parsing arrays
  const serializedMetadata = metadata ? JSON.stringify(metadata) : undefined;

  return (
    <div
      style={VISUALLY_HIDDEN_STYLE}
      aria-hidden="true"
      data-testid={marker}
      data-native-route-marker="true"
      data-native-route-id={routeId}
      data-native-auth-default={authState}
      data-native-data-default={dataState}
      data-native-metadata={serializedMetadata} // Decoded cleanly in E2E via element.getAttribute('data-native-metadata')
    />
  );
}