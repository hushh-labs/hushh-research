import { Suspense } from "react";
import { redirect } from "next/navigation";

import { buildProfileConnectorsPaneHref } from "@/lib/navigation/profile-pane";

import { ProfileConnectorsClientRedirect } from "./profile-connectors-client-redirect";

type ProfileConnectorsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Connectors is a Profile section, never a page of its own. This address
 * (kept for links already out there) opens Connectors in the Profile pane,
 * with `?connector=<id>` opening that connector. On the web the proxy already
 * redirects it; this covers the native bundle, which has no server, and any
 * request the proxy does not see. The provider-registered OAuth return at
 * ./oauth/return is a separate page and is untouched.
 */
export default async function ProfileConnectorsPage({
  searchParams,
}: ProfileConnectorsPageProps) {
  // Awaiting search parameters fails the static export, so the Capacitor
  // bundle reads them on the client instead (see ../page.tsx).
  if (process.env.CAPACITOR_BUILD === "true") {
    return (
      <Suspense fallback={null}>
        <ProfileConnectorsClientRedirect />
      </Suspense>
    );
  }
  const query = (await searchParams) ?? {};
  const connector = Array.isArray(query.connector)
    ? query.connector[0]
    : query.connector;
  redirect(buildProfileConnectorsPaneHref(connector ?? null));
}
