import { expect, it } from "vitest";
import { isFeedItemHidden } from "@/lib/feed/feed-visibility";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

it("keeps repeated location views in the share detail, outside Feed and activity search", () => {
  for (const metadata of [{counterpart_label:"Ankit"},{}]) {
    const item={id:"view",source_domain:"location",event_type:"location_share_viewed",actor_label:"Ankit",metadata,read:false,created_at:"2026-11-19T10:00:00Z"} as FeedItem;
    expect(isFeedItemHidden(item,true)).toBe(true);
    expect(presentFeedItem(item).href).toBeNull();
  }
});
