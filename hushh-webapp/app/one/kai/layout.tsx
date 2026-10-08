import type { ReactNode } from "react";

import { KaiPrivateAgentGate } from "@/components/kai/kai-private-agent-gate";

/** Kai is served from the hub only for a Shared owner (owner_placement_guard.py). */
export default function OneKaiLayout({ children }: { children: ReactNode }) {
  return <KaiPrivateAgentGate>{children}</KaiPrivateAgentGate>;
}
