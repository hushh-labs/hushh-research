import { afterEach, describe, expect, it, vi } from "vitest";

import { commitLocationFlowHistory } from "@/components/one-location/redesign/location-redesign-hub";

afterEach(() => vi.restoreAllMocks());

describe("commitLocationFlowHistory", () => {
  // Next skips syncing useSearchParams for history writes carrying its own
  // `__NA` state. The shell's Back reads those params, so forwarding
  // window.history.state made Back from Share/Ask jump to the One dashboard.
  it.each(["push", "replace"] as const)(
    "%s never forwards Next's internal history state",
    (navigation) => {
      window.history.replaceState({ __NA: true, tree: [] }, "", "/one/location");
      const method = navigation === "push" ? "pushState" : "replaceState";
      const spy = vi.spyOn(window.history, method);

      commitLocationFlowHistory("/one/location?action=share", navigation);

      expect(spy).toHaveBeenCalledWith(null, "", "/one/location?action=share");
    },
  );
});
