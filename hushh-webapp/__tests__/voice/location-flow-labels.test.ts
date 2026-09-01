import { describe, expect, it } from "vitest";

import { LOCATION_FLOW_LABELS } from "@/app/one/location/page";
import { listKaiActions } from "@/lib/voice/kai-action-gateway";

/**
 * How One learns a Location flow was opened.
 *
 * `?action=` never reaches the relay -- `sanitizeRouteQuery` allowlists
 * tab/view/focus/source/category and drops everything else. The signal travels
 * a longer way round: the flow's LABEL becomes `visibleModules`, which feeds
 * the relay's `content_key`, which is what makes a route-context note fire
 * when the route pattern itself has not changed.
 *
 * That matters most for the one flow voice deliberately refuses to complete.
 * Asking for SOS navigates to the control and stops, because sending is
 * reserved for a two-second press-and-hold. The note naming "Emergency SOS"
 * is then the ONLY thing telling One the screen opened -- and a flow with no
 * label here produces no note at all.
 */
describe("every Location flow voice can open announces itself", () => {
  const flowsFromContracts = listKaiActions()
    .filter(
      (action) =>
        action.action_id.startsWith("location.") &&
        action.execution_target.status === "wired" &&
        action.execution_target.path === "route",
    )
    .map((action) => {
      const target = String(action.execution_target.target || "");
      const match = target.match(/[?&]action=([^&]+)/);
      return match ? { actionId: action.action_id, flow: match[1]! } : null;
    })
    .filter((entry): entry is { actionId: string; flow: string } => entry !== null);

  it("has a label for every flow a contract can navigate to", () => {
    // Not a style rule. A missing entry means the person opens that flow by
    // voice and One is never told the screen changed, because the route
    // pattern is identical and the query is stripped before the relay sees it.
    expect(flowsFromContracts.length).toBeGreaterThan(0);
    flowsFromContracts.forEach(({ actionId, flow }) => {
      expect(LOCATION_FLOW_LABELS[flow], `${actionId} opens ?action=${flow}`).toBeTruthy();
    });
  });

  it("names the emergency flow, which has nothing else to announce it", () => {
    // `location.open_sos` is what a spoken emergency request navigates to, and
    // the navigation is deliberately where it stops. If this label ever goes
    // missing, that request becomes completely silent to One rather than
    // merely incomplete.
    //
    // The label says SMS, the flow slug still says `sos`. That split is
    // deliberate and load-bearing: `sos` is the wire value -- the `?action=`
    // slug, the `share_kind`, the route id -- and renaming it would break
    // every stored grant and deep link. SMS is what a person is shown, and
    // this product's own name for it (Save my Soul). The same rule is already
    // enforced for notification copy by
    // one-location-sms-revoke-notification.test.ts.
    const sos = flowsFromContracts.find((entry) => entry.flow === "sos");
    expect(sos?.actionId).toBe("location.open_sos");
    expect(LOCATION_FLOW_LABELS.sos).toBe("Emergency SMS");
    expect(LOCATION_FLOW_LABELS.sos).not.toMatch(/SOS/i);
  });
});
