import { Suspense } from "react";

import LegacyPublicLocationRequestRedirect from "./page-client";

const nativeStaticExportToken =
  process.env.ONE_LOCATION_NATIVE_TEST_PUBLIC_TOKEN || "native-test-token";

export async function generateStaticParams(): Promise<Array<{ token: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ token: nativeStaticExportToken }];
}

/**
 * The path public location links used to carry, kept alive as a forwarder.
 *
 * The page itself moved to `/one/location/view/[token]` — "request" named the
 * submission form this route used to be, not the live location it shows today.
 * Every link minted before that rename is already in somebody's chat, so this
 * route cannot simply stop existing: it forwards to the new one, carrying the
 * token across.
 *
 * `proxy.ts` redirects this prefix server-side on the web, so in practice a
 * browser rarely reaches this component. It exists for the one case the proxy
 * cannot cover: the Capacitor static export, which ships as files with no
 * middleware in front of them.
 */
export default async function LegacyPublicLocationRequestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await params;
  return (
    <Suspense fallback={null}>
      <LegacyPublicLocationRequestRedirect />
    </Suspense>
  );
}
