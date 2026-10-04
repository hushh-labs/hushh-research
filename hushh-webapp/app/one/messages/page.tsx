import { Suspense } from "react";

import { DirectMessagesPage } from "@/components/direct-messages/direct-messages-page";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function OneMessagesPage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading messages…" />}>
      <DirectMessagesPage />
    </Suspense>
  );
}
