import { Suspense } from "react";
import type { Metadata } from "next";

import PublicWalletCardPageClient from "./page-client";

/**
 * The scanned Wallet Profile page must never enter a search index or an AI
 * training corpus: it is a person's contact details, published to whoever
 * holds the link and revocable at any moment. `robots.ts` carries the matching
 * `/c` disallow prefix, and the backend sends `X-Robots-Tag` on the resolve
 * response; this is the third, page-level guard.
 */
export const metadata: Metadata = {
  title: "Shared profile | Hussh One",
  description: "A profile shared from Hussh One.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

const nativeStaticExportToken =
  process.env.ONE_WALLET_CARD_NATIVE_TEST_PUBLIC_TOKEN || "native-test-token";

export async function generateStaticParams(): Promise<Array<{ token: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ token: nativeStaticExportToken }];
}

export default async function PublicWalletCardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await params;
  return (
    <Suspense fallback={null}>
      <PublicWalletCardPageClient />
    </Suspense>
  );
}
