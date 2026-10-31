import type { ReactNode } from "react";

import { requireLocalCrmRoute } from "@/lib/connected-systems/local-crm-route-guard";

export default async function LocalCrmLayout({ children }: { children: ReactNode }) {
  await requireLocalCrmRoute();
  return children;
}
