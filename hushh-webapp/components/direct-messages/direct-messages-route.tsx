"use client";

import { DirectMessagesPage } from "./direct-messages-page";

/**
 * The bare messages route is the conversation inbox. A query selects a
 * conversation, while an empty query intentionally renders the inbox shell so
 * desktop users can choose a person without being sent back to Connect.
 */
export function DirectMessagesRoute() {
  return <DirectMessagesPage />;
}
