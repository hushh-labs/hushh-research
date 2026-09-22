"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { resolvePerfProbeEnablement } from "@/lib/perf/perf-probe-enablement";
import type { FramePacingProbe } from "@/lib/perf/frame-pacing";

/**
 * Mounts the render-performance probe when, and only when, it was asked for.
 *
 * The sampler lives in a separate chunk behind a dynamic import; this file
 * carries no static reference to it, so a normal session pays one effect,
 * one location.search read, one sessionStorage read and, in the native
 * shell, one Preferences.get at boot. Nothing else. See
 * lib/perf/perf-probe-enablement.ts for how it is switched on.
 */
export function RenderPerfProbe() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const router = useRouter();
  const probeRef = useRef<FramePacingProbe | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enablement = await resolvePerfProbeEnablement();
      if (cancelled || !enablement.enabled) return;
      const { startFramePacingProbe } = await import("@/lib/perf/frame-pacing");
      if (cancelled) return;
      probeRef.current = startFramePacingProbe({ hud: enablement.hud, experiments: enablement.experiments });
      probeRef.current.setRoute(window.location.pathname, window.location.search);
      // One navigation at boot, native launch argument only; the auth guard
      // still decides admission (a locked vault detours through /login).
      if (enablement.route && enablement.route !== window.location.pathname + window.location.search) {
        router.replace(enablement.route);
      }
    })();
    return () => {
      cancelled = true;
      probeRef.current?.stop();
      probeRef.current = null;
    };
    // Mount-only: the launch argument is read once per document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    probeRef.current?.setRoute(pathname ?? "/", search ? `?${search}` : "");
  }, [pathname, search]);

  return null;
}
