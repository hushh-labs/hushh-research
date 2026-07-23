import type { PlainLocationPoint } from "@/lib/one-location/types";
import { isNativeUiTestSession } from "@/lib/testing/native-test";

export type LocationMapDemoPerson = {
  key: string;
  label: string;
  point: PlainLocationPoint;
  tint: { r: number; g: number; b: number; a: number };
};

const DEMO_COORDINATES = [
  {
    key: "demo-maya",
    label: "Maya Chen",
    latitude: 37.7793,
    longitude: -122.4192,
    tint: { r: 0, g: 122, b: 255, a: 255 },
  },
  {
    key: "demo-jordan",
    label: "Jordan Lee",
    latitude: 37.7694,
    longitude: -122.4862,
    tint: { r: 52, g: 199, b: 89, a: 255 },
  },
  {
    key: "demo-sam",
    label: "Sam Rivera",
    latitude: 37.8021,
    longitude: -122.4058,
    tint: { r: 255, g: 149, b: 0, a: 255 },
  },
] as const;

export function locationMapDemoPeople(): LocationMapDemoPerson[] {
  const capturedAt = new Date().toISOString();
  return DEMO_COORDINATES.map((person) => ({
    key: person.key,
    label: person.label,
    tint: person.tint,
    point: {
      latitude: person.latitude,
      longitude: person.longitude,
      capturedAt,
      sourcePlatform: "web",
    },
  }));
}

export function isLocationMapDemoEnabled(
  demoParameter: string | null | undefined,
): boolean {
  return demoParameter === "people" && isLocationMapDemoAvailable();
}

/**
 * Fictional people are an operator-only visual fixture. This remains
 * available in local development and injected native UI-test sessions, never
 * as a production user mode.
 */
export function isLocationMapDemoAvailable(): boolean {
  return process.env.NODE_ENV === "development" || isNativeUiTestSession();
}
