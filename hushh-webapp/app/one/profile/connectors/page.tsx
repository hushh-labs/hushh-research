"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Connectors moved into the chat sidebar's "MCP connections" panel -- a
 * standalone page read as empty/dead-end rather than part of the product.
 * This route stays addressable (existing links, the OAuth-return fallback)
 * but only ever bounces into the panel via `?panel=connectors`, read by
 * `AgentChatWorkspace`.
 */
export default function ExternalConnectorsPageRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace(`${ROUTES.HOME}?panel=connectors`);
  }, [router]);

  return <RouteLoadingState label="Opening connectors…" />;
}
