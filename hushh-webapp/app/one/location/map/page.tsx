"use client";

import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";

/**
 * The route stays explicitly authored while secure native Maps provisioning is
 * paused. It intentionally mounts no Location workspace or decrypted state.
 */
export default function OneLocationMapPage() {
  return <LocationImmersiveMap />;
}
