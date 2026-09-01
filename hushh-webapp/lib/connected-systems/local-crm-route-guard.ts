import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isLocalCrmProductAvailable } from "@/lib/connected-systems/crm-product-availability";

export async function requireLocalCrmRoute(): Promise<void> {
  // The native app is a static UAT/production bundle and local CRM is an
  // explicitly localhost-only development surface. Fail closed before reading
  // request headers so Capacitor export never acquires a server dependency.
  if (process.env.CAPACITOR_BUILD === "true") notFound();

  const requestHeaders = await headers();
  const host = String(
    requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "",
  ).split(",")[0];
  if (!isLocalCrmProductAvailable({ hostname: host })) notFound();
}
