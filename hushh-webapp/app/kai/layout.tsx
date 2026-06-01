import type { Metadata } from "next";

import { KaiLayoutShell } from "./kai-layout-shell";

/**
 * Kai Layout
 *
 * Server-side layout that exports page metadata, then delegates
 * all client-side guards and chrome to KaiLayoutShell.
 */

export const metadata: Metadata = {
  title: "Kai",
};

export default function KaiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <KaiLayoutShell>{children}</KaiLayoutShell>;
}
