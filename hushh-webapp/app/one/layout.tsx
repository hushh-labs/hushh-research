import type { ReactNode } from "react";
import { connection } from "next/server";

import { OneAuthGate } from "./one-auth-gate";
import { HushhIntroGate } from "@/components/app-ui/HushhIntroGate";

export default async function OneLayout({ children }: { children: ReactNode }) {
  // Web requests must never reuse authenticated One HTML across people. The
  // Capacitor app has no Next.js server, so its release build deliberately
  // skips this request boundary and emits the same client-owned shell as static
  // files. A route-segment `force-dynamic` export cannot express both modes and
  // makes every iOS/Android static export fail before native compilation.
  if (process.env.CAPACITOR_BUILD !== "true") {
    await connection();
  }

  // HushhIntroGate sits one level above OneAuthGate (and therefore above
  // VaultLockGuard and every other auth/vault guard). It does not just
  // overlay them — it withholds `{children}` (OneAuthGate, VaultLockGuard,
  // the eventual home page) from the tree entirely until its own intro
  // animation finishes, so nothing below it can mount, re-render, or
  // interrupt it mid-play, and there is exactly one splash trigger in the
  // whole app. See that component's file header for the full rationale.
  return (
    <HushhIntroGate>
      <OneAuthGate>{children}</OneAuthGate>
    </HushhIntroGate>
  );
}
