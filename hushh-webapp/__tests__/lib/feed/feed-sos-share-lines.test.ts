import { expect, it } from "vitest";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

function row(event_type:string,audience:string,kind="sos"):FeedItem {
 return {id:"incident",source_domain:"location",event_type,actor_label:null,metadata:{counterpart_label:"Ankit",feed_audience:audience,share_kind:kind},read:false,created_at:"2026-11-19T10:00:00Z"};
}
it.each([
 ["location_share_created","owner","You sent an emergency alert"],
 ["location_share_created","recipient","Emergency alert from Ankit"],
 ["location_share_revoked","owner","Your emergency alert ended"],
 ["location_share_revoked","recipient","Emergency alert from Ankit ended"],
 ["location_share_expired","recipient","Emergency alert from Ankit ended"],
])("uses the true incident audience for %s/%s",(event,audience,label)=>{
 const view=presentFeedItem(row(event,audience));
 expect(view.label).toBe(label);
 expect(view.domainLabel).toBe("Location");
 expect(view.href).toBeNull(); // A receipt without a current grant never opens a map.
});
it("does not call an ordinary share or a private Check-In an emergency",()=>{
 expect(presentFeedItem(row("location_share_created","recipient","share")).label).toBe("Ankit shared their location with you");
 expect(presentFeedItem(row("location_share_created","recipient","check_in")).label).toBe("Ankit sent you a Check-In");
});
