import type { ReactNode } from "react";

import { MarketCurrencyBridge } from "@/components/kai/shared/market-currency-bridge";
import { KaiPrivateAgentGate } from "@/components/kai/kai-private-agent-gate";

/** Kai is served from the hub only for a Shared owner (owner_placement_guard.py). */
export default function OneKaiLayout({ children }: { children: ReactNode }) {
  return (
    <KaiPrivateAgentGate>
      <MarketCurrencyBridge />
      {children}
    </KaiPrivateAgentGate>
  );
}
