import type {
  HushhLocationPermissionState,
  HushhLocationPlugin,
} from "@/lib/capacitor";

function geolocationAvailable(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

export class HushhLocationWeb implements HushhLocationPlugin {
  async getPermissionState(): Promise<HushhLocationPermissionState> {
    if (!geolocationAvailable()) {
      return { state: "unavailable", precise: false, background: "unavailable" };
    }
    if (!navigator.permissions?.query) {
      return { state: "prompt", precise: null, background: "foreground-only" };
    }
    const result = await navigator.permissions.query({
      name: "geolocation" as PermissionName,
    });
    return {
      state: result.state,
      precise: null,
      background: "foreground-only",
    };
  }

  async getCurrentPosition(options?: {
    enableHighAccuracy?: boolean;
    timeoutMs?: number;
  }): Promise<{
    latitude: number;
    longitude: number;
    accuracyM: number | null;
    capturedAt: string;
    sourcePlatform: "web";
  }> {
    if (!geolocationAvailable()) {
      throw new Error("Location is unavailable in this browser.");
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : null,
            capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
            sourcePlatform: "web",
          });
        },
        (error) => {
          reject(new Error(error.message || "Location permission was not granted."));
        },
        {
          enableHighAccuracy: options?.enableHighAccuracy ?? true,
          timeout: options?.timeoutMs ?? 15_000,
          maximumAge: 30_000,
        },
      );
    });
  }
}
