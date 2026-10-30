import { Suspense } from "react";

import { DirectMessagesRoute } from "@/components/direct-messages/direct-messages-route";

export default function OneMessagesPage() {
  return (
    <Suspense fallback={null}>
      <DirectMessagesRoute />
    </Suspense>
  );
}
