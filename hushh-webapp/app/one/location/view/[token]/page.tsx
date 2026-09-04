import { Suspense } from "react";
import { connection } from "next/server";

import PublicLocationViewPageClient from "./page-client";

const nativeStaticExportToken =
  process.env.ONE_LOCATION_NATIVE_TEST_PUBLIC_TOKEN || "native-test-token";

export async function generateStaticParams(): Promise<Array<{ token: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ token: nativeStaticExportToken }];
}

export default async function PublicLocationViewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  // Every web request hits this with a token absent from the (empty)
  // static-params list above, since real tokens are never known at build
  // time -- so 100% of web traffic falls into the "generate on demand"
  // fallback Next.js prerenders a shell for. The `/one` layout ancestor also
  // forces a live per-request render via `connection()` (app/one/layout.tsx,
  // added in 29b967636 so signed-in HTML is never reused across people), but
  // that decision is invisible to THIS leaf's own build-time static/dynamic
  // classification -- the two disagreed at runtime and Next.js bailed out
  // with "Page changed from static to dynamic at runtime, reason:
  // connection" (a 500), observed repeatedly on this route once shared links
  // started getting opened/crawled after that layout change shipped.
  //
  // A route-segment `dynamic` export can't fix this: Turbopack requires that
  // value to be a static string literal, so it can't be gated on
  // CAPACITOR_BUILD the way generateStaticParams above is, and a bare
  // `force-dynamic` breaks Capacitor's `output: export` build outright (the
  // same reason the layout uses `connection()` instead of `dynamic` too).
  // Calling `connection()` again here, in this leaf's own render, ties its
  // static/dynamic classification to the exact same already-correct
  // mechanism instead of inheriting it secondhand from the ancestor.
  if (process.env.CAPACITOR_BUILD !== "true") {
    await connection();
  }
  await params;
  return (
    <Suspense fallback={null}>
      <PublicLocationViewPageClient />
    </Suspense>
  );
}
