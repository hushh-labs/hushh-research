import type { ReactNode } from "react";

import { OneAuthGate } from "./one-auth-gate";
import { HushhIntroGate } from "@/components/app-ui/HushhIntroGate";

export default function OneLayout({ children }: { children: ReactNode }) {
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
