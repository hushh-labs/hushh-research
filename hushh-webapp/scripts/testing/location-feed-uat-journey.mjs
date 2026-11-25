// Normal app/source flows only. These cases never seed or assert provider state.
const request = "/one/location?action=needs-review&requestId={id}";
const received = "/one/location?action=shared-with-me&locationNotification=opened&grantId={id}";
const outgoing = "/one/location?action=active-shares&grantId={id}";
const checkIn = "/one/location?action=private-check-in&checkInId={id}";
const circle = "/one/location?action=circle-detail&circleId={id}";
const source = "Owner-scoped Location request/grant/Check-In and immutable audit receipts";

export const locationUatCases = [
  ["28-location-review", "location-request", "location-owner", "Pending reviewed revision; no access yet", "Maya asked to see your location for 1 hour", "Review", request],
  ["29-location-requester", "location-request", "requester", "Same pending request from requester", "You asked Ankit to share their location", null, "/one/feed"],
  ["30-location-approved-owner", "location-request", "location-owner", "Request confirms resulting active grant", "You’re sharing your location with Maya", null, outgoing],
  ["31-location-approved-recipient", "location-request", "requester", "Same confirmed grant; exact recipient", "Ankit is sharing their location with you", null, received],
  ["32-location-share-expired", "location-request", "requester", "Same grant expired; history has no live map", "Location sharing with Ankit expired", null, "/one/feed"],
  ["33-location-request-expired", "location-expired-request", "location-owner", "Different unanswered request expired; search only", "Request expired", null, "/one/feed"],
  ["34-location-check-in-partial", "location-check-in", "sender", "2 confirmed atomic receipts; 1 intended recipient remains", "You sent a Check-In to 2 of 3 people", "Review remaining", checkIn],
  ["35-location-check-in-full", "location-check-in", "sender", "Retry remaining only; all 3 saved receipts confirmed", "You sent a Check-In to 3 people", null, checkIn],
  ["36-location-check-in-recipient", "location-check-in", "recipient", "Exact recipient grant of the same operation", "Ankit sent you a Check-In", null, received],
  ["37-location-check-in-ended", "location-check-in", "sender", "Same operation ended; dated steps preserved", "Check-In ended", null, checkIn],
  ["38-location-nearby", "location-nearby-presence", "nearby-participant", "Temporary map presence; absent from Feed and activity search", "", "Check out", "/one/location/map"],
  ["39-location-circle-review", "location-circle-membership", "invitee", "Pending invite; joining cannot grant location", "Ankit invited you to Family Circle", "Review", "/one/location?circleInviteId={id}"],
  ["40-location-circle-joined", "location-circle-membership", "circle-owner", "Same accepted membership incarnation", "Maya joined Family Circle", null, circle],
  ["41-location-two-emergencies", "location-emergency", "recipient", "Two independently published active incidents from one sender", "Emergency alert from Ankit", "Open", received + "&feedItemId={feedItemId}"],
  ["42-location-incident-ended", "location-emergency", "recipient", "Selected incident ended; second remains Live", "Emergency alert from Ankit ended", null, "/one/feed"],
  ["43-location-search-old", "old-location", "recipient", "Older authorized exact workflow found by person, Circle, Check-In, event and date", "Ankit sent you a Check-In", null, "/one/feed"],
  ["44-location-history-refresh", "old-location", "recipient", "Old rows safe; no duplicate unread after two-session refresh", "Location", null, "/one/feed"],
].map(([key, family, role, state, copy, action, destination]) =>
  Object.freeze({ key, section: "Location", family, role, state, copy, action, destination, authority: source,
    selectorIsOperation: ["28", "29", "33", "34", "35", "37", "39", "41", "42", "43", "44"].includes(key.slice(0, 2)),
    feedGroup: ["29", "32", "33"].includes(key.slice(0, 2)) ? "location-request:{operationId}"
      : ["42", "43", "44"].includes(key.slice(0, 2)) ? "location-grant:{operationId}" : null })
);
