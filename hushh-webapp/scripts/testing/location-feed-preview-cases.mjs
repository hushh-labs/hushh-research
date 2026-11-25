// Synthetic design journeys. No provider result or live account state is asserted.
const grant="20000000-1000-4000-8000-000000000001";
const request="20000000-1000-4000-8000-000000000002";
const checkIn="20000000-1000-4000-8000-000000000003";
const circle="20000000-1000-4000-8000-000000000004";
const history="/one/feed · exact recorded incident";
const rows=[
  ["00-mixed","recipient","Two independent incidents; two decisions; mixed activity","Emergency alert from Ankit",null,`/one/location?locationNotification=opened&grantId=${grant}`,null,{}],
  ["01-approval","location-owner","Revision 1 pending; access not granted","Maya asked to see your location for 1 hour","Review",`/one/location?section=approvals&requestId=${request}`,null,{}],
  ["02-approved-owner","location-owner","Same request; confirmed active grant","",null,"","location_access_approved",{feed_audience:"owner",current_location_status:"active",duration_hours:1}],
  ["03-approved-recipient","requester","Same confirmed grant; recipient view","",null,"","location_access_approved",{feed_audience:"recipient",current_location_status:"active",duration_hours:1}],
  ["04-expired-share","recipient","Server confirms grant expired","",null,history,"location_share_expired",{share_kind:"share"}],
  ["05-request-expired-search","location-owner","Unanswered request is history only","",null,history,"location_access_request",{current_location_status:"expired"}],
  ["06-check-in-full","sender","3 intended recipients; 3 atomic ciphertext receipts","",null,"","location_check_in_result",{confirmed_count:3,intended_count:3,user_facing_status:"completed",check_in_operation_id:checkIn,current_check_in_available:true}],
  ["07-check-in-partial","sender","2 saved receipts; 1 remaining recipient","You sent a Check-In to 2 of 3 people","Review remaining",`/one/location?action=private-check-in&checkInId=${checkIn}`,null,{}],
  ["08-check-in-recipient","recipient","Recipient's exact saved Check-In share","",null,"","location_share_created",{share_kind:"check_in",current_location_status:"active",duration_hours:1}],
  ["09-nearby","nearby-participant","Nearby presence is map-only; no Feed or search item","",null,"/one/location/map",null,{}],
  ["10-circle-review","invitee","Pending Circle invitation; joining grants no location","Ankit invited you to Family Circle","Review",`/one/location?circleInviteId=${request}`,null,{}],
  ["11-circle-outcome","circle-owner","Membership changed independently of location access","",null,"","circle_member_left",{circle_id:circle,circle_name:"Family Circle",counterpart_label:"Ankit"}],
  ["12-alert-ended","recipient","Same confirmed incident ended; no stale map","",null,history,"location_share_revoked",{share_kind:"sos",reason:"owner_revoke"}],
  ["13-search-old","recipient","Older Check-In receipt; live source unavailable","",null,history,"location_share_created",{share_kind:"check_in"}],
];
export const locationPreviewCases=rows.map(([suffix,role,state,copy,action,destination,event,metadata])=>({
  key:`location-${suffix}`,section:"Location",family:"location",role,state,copy,action,destination,
  authority:"Location request/grant/operation + immutable audit receipts; live UAT not run",
  ...(event?{feedItem:{id:`preview-${suffix}`,activity_group_id:`location-grant:${grant}`,source_domain:"location",subagent_id:"agent_location",event_type:event,actor_label:"Maya",
    metadata:{counterpart_label:"Maya",feed_audience:"recipient",request_id:request,grant_id:grant,...metadata},read:true,created_at:"2026-10-16T09:41:00Z"}}:{}),
}));
