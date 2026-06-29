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
      return {
        state: "unavailable",
        precise: false,
        background: "unavailable",
        locationServicesEnabled: false,
      };
    }
    if (!navigator.permissions?.query) {
      return {
        state: "prompt",
        precise: null,
        background: "foreground-only",
        locationServicesEnabled: null,
      };
    }
    const result = await navigator.permissions.query({
      name: "geolocation" as PermissionName,
    });
    return {
      state: result.state,
      precise: null,
      background: "foreground-only",
      locationServicesEnabled: null,
    };
  }

  async requestLocationPermission(): Promise<HushhLocationPermissionState> {
    if (!geolocationAvailable()) {
      return {
        state: "unavailable",
        precise: false,
        background: "unavailable",
        locationServicesEnabled: false,
      };
    }

    await this.getCurrentPosition({
      enableHighAccuracy: true,
      timeoutMs: 15_000,
    });
    return this.getPermissionState();
  }

  async openAppSettings(): Promise<{
    opened: boolean;
    sourcePlatform: "web";
  }> {
    return { opened: false, sourcePlatform: "web" };
  }

  async openLocationSettings(): Promise<{
    opened: boolean;
    sourcePlatform: "web";
  }> {
    return { opened: false, sourcePlatform: "web" };
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

    const timeoutMs = options?.timeoutMs ?? 15_000;

    const attempt = (enableHighAccuracy: boolean) =>
      new Promise<{
        latitude: number;
        longitude: number;
        accuracyM: number | null;
        capturedAt: string;
        sourcePlatform: "web";
      }>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracyM: Number.isFinite(position.coords.accuracy)
                ? position.coords.accuracy
                : null,
              capturedAt: new Date(
                position.timestamp || Date.now(),
              ).toISOString(),
              sourcePlatform: "web",
            });
          },
          (error) => reject(error),
          {
            enableHighAccuracy,
            timeout: timeoutMs,
            maximumAge: 30_000,
          },
        );
      });

    // The browser GeolocationPositionError codes: 1 = PERMISSION_DENIED,
    // 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT. Many desktops have no GPS, so a
    // high-accuracy request can fail with POSITION_UNAVAILABLE/TIMEOUT even when
    // the site permission is granted — that previously surfaced as a misleading
    // "User denied Geolocation". We therefore (a) only treat code 1 as a real
    // permission denial, and (b) automatically retry once at low accuracy for
    // unavailable/timeout so it "just works" on desktops without GPS.
    const wantsHighAccuracy = options?.enableHighAccuracy ?? true;
    try {
      return await attempt(wantsHighAccuracy);
    } catch (rawError) {
      const error = rawError as Partial<GeolocationPositionError> | undefined;
      const code = typeof error?.code === "number" ? error.code : undefined;

      if (code === 1) {
        // PERMISSION_DENIED — surface a clear, actionable permission message.
        const denied = new Error(
          "Location permission is blocked for this site. Allow location access in your browser's site settings, then try again.",
        );
        denied.name = "LocationPermissionDeniedError";
        throw denied;
      }

      // POSITION_UNAVAILABLE (2) or TIMEOUT (3): retry once at low accuracy,
      // which succeeds on desktops/laptops that only have coarse network
      // location.
      if (code === 2 || code === 3 || code === undefined) {
        if (wantsHighAccuracy) {
          try {
            return await attempt(false);
          } catch (retryRaw) {
            const retryError = retryRaw as
              | Partial<GeolocationPositionError>
              | undefined;
            if (retryError?.code === 1) {
              const denied = new Error(
                "Location permission is blocked for this site. Allow location access in your browser's site settings, then try again.",
              );
              denied.name = "LocationPermissionDeniedError";
              throw denied;
            }
            throw new Error(
              "Could not get your location. Turn on Location for your device/browser and try again.",
            );
          }
        }
        throw new Error(
          "Could not get your location. Turn on Location for your device/browser and try again.",
        );
      }

      throw new Error(
        (error as Error | undefined)?.message ||
          "Could not get your location. Try again.",
      );
    }
  }

  // Continuous, movement-driven tracking via the browser Geolocation watch API.
  // Each new fix the device reports (as the user moves) invokes the callback, so
  // recipients see live movement rather than only a 20s poll. Foreground-only.
  async watchPosition(
    options: {
      enableHighAccuracy?: boolean;
      timeoutMs?: number;
    },
    callback: (
      point: {
        latitude: number;
        longitude: number;
        accuracyM: number | null;
        capturedAt: string;
        sourcePlatform: "web" | "ios" | "android" | "native";
      } | null,
      error?: { message: string; code?: number } | null,
    ) => void,
  ): Promise<string> {

    if (!geolocationAvailable()) {
      callback(null, {
        message: "Location is unavailable in this browser.",
      });
      return "";
    }

    const enableHighAccuracy = options?.enableHighAccuracy ?? true;
    const timeoutMs = options?.timeoutMs ?? 20_000;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        callback(
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : null,
            capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
            sourcePlatform: "web",
          },
          null,
        );
      },
      (error) => {
        // Code 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        // Surface the error but keep the watch alive so a transient
        // unavailable/timeout can recover on the next fix.
        callback(null, {
          message:
            error?.code === 1
              ? "Location permission is blocked for this site. Allow location access in your browser's site settings, then try again."
              : "Could not get your location. Turn on Location for your device/browser and try again.",
          code: error?.code,
        });
      },
      {
        enableHighAccuracy,
        timeout: timeoutMs,
        maximumAge: 0,
      },
    );

    return String(watchId);
  }

  async clearWatch(options: { id: string }): Promise<void> {
    if (!geolocationAvailable()) return;
    const watchId = Number(options?.id);
    if (Number.isFinite(watchId)) {
      navigator.geolocation.clearWatch(watchId);
    }
  }
}

