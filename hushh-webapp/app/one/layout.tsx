import type { ReactNode } from "react";
import { connection } from "next/server";

import { OneAuthGate } from "./one-auth-gate";

export default async function OneLayout({ children }: { children: ReactNode }) {
  // Web requests must never reuse authenticated One HTML across people. The
  // Capacitor app has no Next.js server, so its release build deliberately
  // skips this request boundary and emits the same client-owned shell as static
  // files. A route-segment `force-dynamic` export cannot express both modes and
  // makes every iOS/Android static export fail before native compilation.
  if (process.env.CAPACITOR_BUILD !== "true") {
    await connection();
  }

  // The authenticated One tree mounts directly. There is no post-login
  // greeting splash or animation gate between the route and its auth/vault
  // boundary.
  return <OneAuthGate>{children}</OneAuthGate>;
}
