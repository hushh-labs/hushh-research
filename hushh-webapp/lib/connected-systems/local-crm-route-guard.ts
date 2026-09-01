import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isLocalCrmProductAvailable } from "@/lib/connected-systems/crm-product-availability";

export async function requireLocalCrmRoute(): Promise<void> {
  // Capacitor uses a static export, where request headers do not exist. CRM is
  // deliberately local-development-only, so fail closed before reading them.
  if (process.env.CAPACITOR_BUILD === "true") notFound();

  const requestHeaders = await headers();
  const host = String(
    requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "",
  ).split(",")[0];
  if (!isLocalCrmProductAvailable({ hostname: host })) notFound();
}
