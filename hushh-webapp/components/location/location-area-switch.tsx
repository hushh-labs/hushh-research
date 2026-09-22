"use client";

import type { ReactNode } from "react";

import { LocationRedesignSkeleton } from "@/components/one-location/redesign/location-redesign-skeleton";
import { useOneVoiceReadiness } from "@/lib/one-voice/readiness";

/**
 * Page-level switch between the voice-first Location area and the legacy hub.
 *
 * One route, two trees: the server-owned readiness flag decides. While
 * readiness is unknown (first load per session) a skeleton renders so the
 * page never flips trees after it has painted.
 */
export function LocationAreaSwitch({
  live,
  legacy,
}: {
  live: ReactNode;
  legacy: ReactNode;
}) {
  const readiness = useOneVoiceReadiness();
  if (readiness.status === "unknown") return <LocationRedesignSkeleton />;
  return <>{readiness.liveEnabled ? live : legacy}</>;
}
