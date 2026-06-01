import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

export const metadata: Metadata = {
  title: "Marketplace",
};

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return <PhoneMandateGuard exemptVaultUsers>{children}</PhoneMandateGuard>;
}
