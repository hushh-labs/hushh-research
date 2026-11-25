const wasmUrl = "/one-presence/rive.wasm";

export async function fetchOnePresenceBytes(url: string, signal: AbortSignal, cache?: RequestCache) {
  // eslint-disable-next-line no-restricted-syntax -- Bundled public artwork uses the same origin in web and native WebViews.
  const response = await fetch(url, { signal, cache });
  if (!response.ok) throw new Error(`One presence asset returned ${response.status}`);
  return response.arrayBuffer();
}

// The WASM runtime is shared by both surfaces. Own the WASM fetch so a stalled
// connection cannot leave the SDK singleton waiting forever on its first load.
let reloadWasm = false;
let runtimePromise: Promise<typeof import("@rive-app/canvas")> | undefined;
export function loadOnePresenceRuntime() {
  runtimePromise ??= (async () => {
    const runtime = await import("@rive-app/canvas");
    const loader = runtime.RuntimeLoader;
    loader.setWasmUrl(wasmUrl);
    loader.setWasmFallbackUrl(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 4100);
    try {
      loader.setWasmBinary(await fetchOnePresenceBytes(wasmUrl, controller.signal, reloadWasm ? "reload" : undefined));
      await loader.awaitInstance();
    } finally {
      window.clearTimeout(timer);
      loader.setWasmBinary(null);
    }
    return runtime;
  })().catch(error => {
    runtimePromise = undefined;
    reloadWasm = true;
    throw error;
  });
  return runtimePromise;
}
