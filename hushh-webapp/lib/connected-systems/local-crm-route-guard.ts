import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isLocalCrmProductAvailable } from "@/lib/connected-systems/crm-product-availability";

export async function requireLocalCrmRoute(): Promise<void> {
  const requestHeaders = await headers();
  const host = String(
    requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "",
  ).split(",")[0];
  if (!isLocalCrmProductAvailable({ hostname: host })) notFound();
}
