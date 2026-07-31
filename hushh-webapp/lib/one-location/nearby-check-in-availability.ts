import { resolveAppEnvironment } from "@/lib/app-env";

/**
 * Radius-based nearby discovery is a local/UAT simulation until production
 * admission and abuse-prevention controls are available. The backend remains
 * authoritative; this frontend gate prevents collecting a location for a flow
 * that production will reject.
 */
export function isOneLocationNearbyCheckInAvailable(): boolean {
  return resolveAppEnvironment() !== "production";
}
