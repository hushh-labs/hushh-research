// Delivery classification for GA4 collect hits observed by the UAT analytics
// smoke.
//
// gtag sends hits as beacons (sendBeacon / keepalive fetch). Chromium reports
// such a request as `requestfailed` with net::ERR_ABORTED once the page stops
// reading the response, even after GA4 has answered 204, and never emits
// `requestfinished` for it. GA4's 2xx is the delivery acknowledgement, so a
// hit counts as delivered only when a 2xx response exists; the one failure
// ignored is that post-response beacon abort.

export const BEACON_POST_RESPONSE_ABORT = "net::ERR_ABORTED";

export function classifyCollectSettlement({ settledBy, responseStatus, failureText }) {
  const acknowledged =
    Number.isInteger(responseStatus) && responseStatus >= 200 && responseStatus < 300;
  if (!acknowledged) return "failed";
  if (settledBy === "requestfinished") return "finished";
  if (settledBy === "requestfailed" && failureText === BEACON_POST_RESPONSE_ABORT) {
    return "finished";
  }
  return "failed";
}
