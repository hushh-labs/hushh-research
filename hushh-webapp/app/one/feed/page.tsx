import { Suspense } from "react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { FeedPage } from "@/components/feed/feed-page";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function OneFeedPage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading feed…" />}>
      <>
        <NativeTestBeacon
          routeId="/one/feed"
          marker="native-route-feed"
          authState="authenticated"
          dataState="loaded"
        />
        <FeedPage />
      </>
    </Suspense>
  );
}
