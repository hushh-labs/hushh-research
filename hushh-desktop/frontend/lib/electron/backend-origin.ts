// lib/electron/backend-origin.ts
//
// POC: teach the Electron shell to resolve its own backend origin at
// runtime (via IPC to the main process, which already knows the
// dynamically-allocated Python backend port for this launch) instead of
// relying on NEXT_PUBLIC_BACKEND_URL, which is baked into the client
// bundle at build time and can't reflect a per-launch port.
//
// Resolution is async (IPC) but callers (api-service.ts) need a
// synchronous read, so this caches the resolved origin after one
// early call. Until it resolves, callers fall back to their existing
// behavior (relative path via the Next.js proxy), so there is no
// window where a request can be sent nowhere.

declare global {
  interface Window {
    hushh?: {
      platform?: {
        isDesktop?: boolean;
        getInfo?: () => Promise<{ backendOrigin?: string } & Record<string, unknown>>;
      };
    };
  }
}

let cachedBackendOrigin = "";
let primePromise: Promise<void> | null = null;

export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && window.hushh?.platform?.isDesktop === true;
}

/** Synchronous read of the cached backend origin. Empty string until primed. */
export function getElectronBackendOrigin(): string {
  return cachedBackendOrigin;
}

/** Resolves the live backend origin from the main process. Safe to call multiple times. */
export function primeElectronBackendOrigin(): Promise<void> {
  if (!isElectronRuntime()) {
    return Promise.resolve();
  }
  if (primePromise) {
    return primePromise;
  }

  primePromise = (async () => {
    try {
      const info = await window.hushh?.platform?.getInfo?.();
      if (typeof info?.backendOrigin === "string" && info.backendOrigin) {
        cachedBackendOrigin = info.backendOrigin.replace(/\/+$/, "");
        if (process.env.NODE_ENV !== "production") {
          console.debug(`[electron/backend-origin] resolved backendOrigin=${cachedBackendOrigin}`);
        }
      }
    } catch (error) {
      console.warn("[electron/backend-origin] Failed to resolve backend origin:", error);
    }
  })();

  return primePromise;
}
