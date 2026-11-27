import { Suspense } from "react";

import { FeedWithRecordDetail } from "@/components/feed/feed-funding-detail";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function OneFeedPage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading feed…" />}>
      <FeedWithRecordDetail />
    </Suspense>
  );
}
