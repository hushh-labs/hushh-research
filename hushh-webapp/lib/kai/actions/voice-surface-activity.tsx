"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Marks whether a subtree is the surface the person is actually looking at.
 *
 * A swipe pager keeps every panel mounted, so a background panel keeps
 * publishing voice surface metadata. Because the publisher store resolves
 * screen identity from the most recent route publisher, a background panel
 * that republishes on live data (market prices, for one) permanently wins
 * identity from the panel in view -- One then narrates, and offers actions
 * for, a screen the person is not on.
 *
 * Publishing is gated on this rather than on `aria-hidden` so the rule holds
 * for any pager, not just ones whose panels happen to render that attribute.
 */
const VoiceSurfaceActivityContext = createContext(true);

export function VoiceSurfaceActivityBoundary({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  // A nested pager inside a background panel stays inactive regardless of its
  // own selection, so activity composes down the tree instead of resetting.
  const parentActive = useContext(VoiceSurfaceActivityContext);
  return (
    <VoiceSurfaceActivityContext.Provider value={parentActive && active}>
      {children}
    </VoiceSurfaceActivityContext.Provider>
  );
}

export function useVoiceSurfaceActive(): boolean {
  return useContext(VoiceSurfaceActivityContext);
}
