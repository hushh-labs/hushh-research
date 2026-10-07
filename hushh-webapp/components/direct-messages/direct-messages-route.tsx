"use client";

import { useSearchParams } from "next/navigation";

import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

import { DirectMessagesPage } from "./direct-messages-page";

/**
 * Direct messages are entered from a connected person's Message action.
 * The retired bare inbox address remains safe for old links, but it now
 * returns the person to Connect instead of rendering a second destination.
 */
export function DirectMessagesRoute() {
  const searchParams = useSearchParams();
  const personRef = String(searchParams?.get("person") || "").trim();
  const conversationId = String(
    searchParams?.get("conversation") || "",
  ).trim();

  if (!personRef && !conversationId) {
    return <ClientRedirect to={ROUTES.CONNECT} redirectRouteId="one_messages" />;
  }

  return <DirectMessagesPage />;
}
