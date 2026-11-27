"use client";

import { useInterfaceRevision } from "@/lib/capacitor/native-interface-revision";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";

/** Stationary viewport seat owned by the shell, not a scrolling page's height.
 * Route width/gutters come from its authored AppPageShell, not this seat. */
export function NativeWorkspaceSeat() {
  useInterfaceRevision();
  if (!customNativePresentationEnabled()) return null;
  return <div aria-hidden data-native-workspace-seat="true" className="pointer-events-none fixed inset-x-0"
    style={{ top: "var(--native-workspace-top, var(--app-top-content-offset, 0px))", bottom: "var(--native-workspace-paint-bottom, var(--kb-height, 0px))",
      paddingBottom: "max(0px, calc(max(var(--native-workspace-bottom, var(--bottom-chrome-stack-height, 0px)), var(--kb-height, 0px)) - var(--native-workspace-paint-bottom, var(--kb-height, 0px))))", visibility: "hidden" }} />;
}
