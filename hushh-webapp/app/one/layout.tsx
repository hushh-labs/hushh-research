import type { ReactNode } from "react";

import { OneAuthGate } from "./one-auth-gate";

export default function OneLayout({ children }: { children: ReactNode }) {
  return <OneAuthGate>{children}</OneAuthGate>;
}
