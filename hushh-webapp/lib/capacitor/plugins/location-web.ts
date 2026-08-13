import type {
  BackgroundShareSession,
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
    // "We could not read the permission" must resolve to `prompt`, never to a
    // denial. WebKit does not support the `geolocation` name in the Permissions
    // API, so on every iPhone this query REJECTS — and an unguarded await here
    // used to surface as `unavailable` upstream, which blocked sharing and
    // pinned the toggle off on a device whose location worked perfectly.
    //
    // `prompt` is the honest answer to not knowing: it means "ask the device".
    // Geolocation itself exists (checked above); only our ability to introspect
    // it is missing.
    const unknownButAskable: HushhLocationPermissionState = {
      state: "prompt",
      precise: null,
      background: "foreground-only",
      locationServicesEnabled: null,
    };
    if (!navigator.permissions?.query) {
      return unknownButAskable;
    }
    try {
      const result = await navigator.permissions.query({
        name: "geolocation" as PermissionName,
      });
      return {
        state: result.state,
        precise: null,
        background: "foreground-only",
        locationServicesEnabled: null,
      };
    } catch {
      return unknownButAskable;
    }
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

  async requestAlwaysAuthorization(): Promise<HushhLocationPermissionState> {
    // Browsers have no "always" location tier.
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

    type WebFix = {
      latitude: number;
      longitude: number;
      accuracyM: number | null;
      capturedAt: string;
      sourcePlatform: "web";
    };

    // Accuracy (meters) at which we stop sampling early — a confident fix.
    const TARGET_ACCURACY_M = 35;

    // How long to keep refining AFTER the first usable fix lands. The sampling
    // budget below is the ceiling for finding ANY fix at all; once one is in
    // hand, holding the caller for the rest of it buys accuracy nobody is
    // waiting for. It cost the most on the devices that could least afford it:
    // a laptop with no GPS produces one coarse fix and no better one is ever
    // coming, so every capture sat out the entire budget before returning a
    // result it already had within a few hundred milliseconds.
    const REFINE_AFTER_FIRST_FIX_MS = 1_200;

    const toFix = (position: GeolocationPosition): WebFix => ({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: Number.isFinite(position.coords.accuracy)
        ? position.coords.accuracy
        : null,
      capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
      sourcePlatform: "web",
    });

    const isBetter = (candidate: WebFix, current: WebFix | null): boolean => {
      if (!current) return true;
      // Prefer a fix that reports accuracy over one that does not.
      if (candidate.accuracyM == null) return false;
      if (current.accuracyM == null) return true;
      return candidate.accuracyM < current.accuracyM;
    };

    // How old a cached fix may be before the last-resort reader refuses it.
    // Deliberately far below the 60s the backend allows between capture and
    // confirmation, so a fix accepted here still passes the server's freshness
    // check and still describes where the user actually is.
    const LAST_RESORT_MAX_AGE_MS = 30_000;

    // Single-shot reader (used for the low-accuracy desktop fallback). Defaults
    // to a FRESH fix (maximumAge: 0) so a stale cached position from a previous
    // place is never returned as "current location".
    const readOnce = (enableHighAccuracy: boolean, maximumAge = 0) =>
      new Promise<WebFix>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (position) => resolve(toFix(position)),
          (error) => reject(error),
          { enableHighAccuracy, timeout: timeoutMs, maximumAge },
        );
      });

    // Best-of-samples reader: collect fresh fixes via watchPosition for a short
    // budget and return the most accurate one. This prevents the occasional
    // wildly-off first reading (coarse network/IP fix or a stale cache) from
    // being shown as the user's current location. Resolves early once a fix is
    // accurate enough; otherwise returns the best sample seen when the budget
    // elapses.
    const sampleBest = (enableHighAccuracy: boolean, budgetMs: number) =>
      new Promise<WebFix>((resolve, reject) => {
        let best: WebFix | null = null;
        let settled = false;
        let watchId: number | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let refineTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          if (refineTimer !== null) {
            clearTimeout(refineTimer);
            refineTimer = null;
          }
          if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
          }
        };
        const finish = (value: WebFix | null, error?: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (value) resolve(value);
          else reject(error);
        };

        try {
          watchId = navigator.geolocation.watchPosition(
            (position) => {
              const fix = toFix(position);
              if (isBetter(fix, best)) best = fix;
              if (
                best?.accuracyM != null &&
                best.accuracyM <= TARGET_ACCURACY_M
              ) {
                finish(best);
                return;
              }
              // First fix in hand but not yet confident. Give later fixes a
              // short window to beat it — enough to reject one jumpy reading,
              // which is the whole point of sampling — then return the best of
              // them rather than waiting out the full budget.
              if (refineTimer === null) {
                refineTimer = setTimeout(
                  () => finish(best),
                  REFINE_AFTER_FIRST_FIX_MS,
                );
              }
            },
            (error) => {
              // Only a hard permission denial should abort sampling; transient
              // unavailable/timeout errors are ignored so a later fix can land.
              if ((error as GeolocationPositionError)?.code === 1) {
                finish(null, error);
              }
            },
            { enableHighAccuracy, timeout: budgetMs, maximumAge: 0 },
          );
        } catch (error) {
          finish(null, error);
          return;
        }

        timer = setTimeout(() => {
          if (best) finish(best);
          else finish(null, { code: 3 } as GeolocationPositionError);
        }, budgetMs);
      });

    const attempt = (enableHighAccuracy: boolean) => {
      if (!enableHighAccuracy) return readOnce(false);
      // Sample within a bounded window (cap at 9s) so the picker stays snappy
      // while still rejecting a single jumpy reading.
      const budgetMs = Math.min(Math.max(timeoutMs, 1_000), 9_000);
      return sampleBest(true, budgetMs);
    };


    // Last resort before telling a user with working Location that we could not
    // find them. Both fresh readers demand `maximumAge: 0`, so a browser whose
    // provider is momentarily unable to produce a NEW fix fails even though it
    // is holding a perfectly good one from seconds ago — the exact shape of the
    // "location is on but sharing says it is off" reports. Accept that cached
    // fix when it is recent enough to still be true, and only then give up.
    const lastResortCachedFix = async (): Promise<WebFix> => {
      try {
        return await readOnce(false, LAST_RESORT_MAX_AGE_MS);
      } catch (cachedRaw) {
        const cachedError = cachedRaw as
          | Partial<GeolocationPositionError>
          | undefined;
        if (cachedError?.code === 1) {
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
    };

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
            return await lastResortCachedFix();
          }
        }
        return await lastResortCachedFix();
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

  async startBackgroundShare(
    _session: BackgroundShareSession,
  ): Promise<{ started: boolean; reason?: string }> {
    // Web tabs cannot run location updates in the background (timers freeze when
    // hidden; no GPS in service workers). Always report unsupported.
    return { started: false, reason: "unsupported-on-web" };
  }

  async stopBackgroundShare(): Promise<void> {
    // No-op on web; nothing was started.
  }
}

