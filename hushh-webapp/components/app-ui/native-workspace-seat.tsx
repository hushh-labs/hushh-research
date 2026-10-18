"use client";

import { APP_SHELL_MAX_WIDTHS } from "./app-page-shell";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useLayoutEffect, useState } from "react";

/** Stationary viewport seat owned by the shell, not a scrolling page's height.
 * The reading measure and chrome reservations have their existing owners. */
export function NativeWorkspaceSeat() {
  const [enabled, setEnabled] = useState(false);
  useLayoutEffect(() => { setEnabled(customNativePresentationEnabled()); }, []);
  if (!enabled) return null;
  return <div aria-hidden data-native-workspace-seat="true" className={`pointer-events-none fixed inset-x-0 mx-auto ${APP_SHELL_MAX_WIDTHS.reading}`}
    style={{ top: "var(--app-top-content-offset, 0px)", bottom: "var(--bottom-chrome-stack-height, 0px)", visibility: "hidden" }} />;
}
