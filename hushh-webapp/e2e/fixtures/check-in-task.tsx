import React from "react";
import { createRoot } from "react-dom/client";
import { NearbyCheckInSheet } from "../../components/one-location/nearby-check-in/nearby-check-in-sheet";
const captureCurrentPosition = async () => ({ latitude: 37.4275, longitude: -122.1697, accuracyM: 9, capturedAt: new Date().toISOString(), sourcePlatform: "web" as const });
createRoot(document.getElementById("root")!).render(
  <NearbyCheckInSheet open ownerId="fixture-owner" vaultOwnerToken="fixture-owner-token"
    captureCurrentPosition={captureCurrentPosition} onOpenChange={() => undefined} />,
);
