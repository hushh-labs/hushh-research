import type { ReactNode } from "react";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return <PhoneMandateGuard exemptVaultUsers>{children}</PhoneMandateGuard>;
}
