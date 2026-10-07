import { Suspense } from "react";

import { DirectMessagesRoute } from "@/components/direct-messages/direct-messages-route";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function OneMessagesPage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading messages…" />}>
      <DirectMessagesRoute />
    </Suspense>
  );
}
