import { Suspense } from "react";

import PublicLocationViewPageClient from "./page-client";

const nativeStaticExportToken =
  process.env.ONE_LOCATION_NATIVE_TEST_PUBLIC_TOKEN || "native-test-token";

export async function generateStaticParams(): Promise<Array<{ token: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ token: nativeStaticExportToken }];
}

/**
 * Every web request hits this with a token absent from the (empty)
 * static-params list above, since real tokens are never known at build time
 * -- so 100% of web traffic falls into the "generate on demand" fallback
 * Next.js prerenders a shell for. The `/one` layout ancestor also forces a
 * live per-request render here via `connection()` (`app/one/layout.tsx`,
 * added in 29b967636 so signed-in HTML is never reused across people), but
 * that decision is invisible to this leaf's own build-time static/dynamic
 * classification -- the two disagreed at runtime and Next.js bailed out
 * with "Page changed from static to dynamic at runtime, reason: connection"
 * (a 500), observed repeatedly on this route once shared links started
 * getting opened/crawled after that layout change shipped. Declaring this
 * leaf dynamic too removes the ambiguity outright. Capacitor's static export
 * needs the opposite -- a real static page for its one baked-in test token,
 * with no server to run `connection()` against -- so this stays gated
 * exactly like `generateStaticParams` above.
 */
export const dynamic =
  process.env.CAPACITOR_BUILD === "true" ? "auto" : "force-dynamic";

export default async function PublicLocationViewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await params;
  return (
    <Suspense fallback={null}>
      <PublicLocationViewPageClient />
    </Suspense>
  );
}
