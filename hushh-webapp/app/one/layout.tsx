import type { ReactNode } from "react";

import { OneAuthGate } from "./one-auth-gate";
import { HushhIntroGate } from "@/components/app-ui/HushhIntroGate";

export default function OneLayout({ children }: { children: ReactNode }) {
  // HushhIntroGate sits one level above OneAuthGate and plays OVER it. The
  // guards below mount and settle while the animation runs, so the screen the
  // intro fades to has already resolved and has nothing left to flicker. It
  // used to withhold them from the tree for the full three seconds, which left
  // every guard resolving in the one frame after the fade — see that
  // component's file header.
  return (
    <HushhIntroGate>
      <OneAuthGate>{children}</OneAuthGate>
    </HushhIntroGate>
  );
}
