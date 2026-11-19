import { expect, it } from "vitest";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

it.each([
  ["location_sms_contact_added","owner","Ankit can receive your emergency alerts"],
  ["location_sms_contact_removed","owner","Ankit no longer receives your emergency alerts"],
  ["location_sms_contact_added","recipient","You can receive Ankit’s emergency alerts"],
  ["location_sms_contact_removed","recipient","You no longer receive Ankit’s emergency alerts"],
])("names whose alerts changed for %s/%s",(event_type,audience,label)=>{
  const item={id:"relationship",source_domain:"location",event_type,actor_label:null,metadata:{counterpart_label:"Ankit",feed_audience:audience,circle_id:"11111111-1111-4111-8111-111111111111"},read:false,created_at:"2026-11-19T10:00:00Z"} as FeedItem;
  const view=presentFeedItem(item);
  expect(view.label).toBe(label);
  expect(view.domainLabel).toBe("Location");
  expect(view.description).toBe("");
  expect(view.href).toBeNull(); // History never widens access to an ended Circle.
  const current=presentFeedItem({...item,metadata:{...item.metadata,current_circle_available:true}});
  expect(current.href).toBe("/one/location?action=circle-detail&circleId=11111111-1111-4111-8111-111111111111");
});
