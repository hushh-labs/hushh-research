import { Suspense } from "react";

import { FeedPage } from "@/components/feed/feed-page";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function OneFeedPage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading feed…" />}>
      <FeedPage />
    </Suspense>
  );
}
