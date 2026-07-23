"use client";

import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";

/** Private, immersive Map. It owns no persistent app chrome or route-local map state. */
export default function OneLocationMapPage() {
  return <LocationImmersiveMap />;
}
