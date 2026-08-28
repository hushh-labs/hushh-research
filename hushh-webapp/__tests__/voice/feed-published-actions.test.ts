import { describe, expect, it } from "vitest";

import { listKaiActionsForSurface } from "@/lib/voice/kai-action-gateway";

/**
 * The Feed screen published nothing to voice at all until this was added --
 * neither app/one/feed/page.tsx nor components/feed/feed-page.tsx called
 * usePublishVoiceSurfaceMetadata.
 *
 * That mattered more here than on most screens. connect.accept_request and
 * connect.reject_request name `one_feed` as their reachable screen, so the one
 * place where "accept their request" is the obvious thing to say was the one
 * place voice never offered it. Both execute backend-direct, so they always
 * ran if the model went looking -- they were simply never suggested.
 *
 * These tests pin the contract side of that: the actions really are declared
 * for this screen, and really are runnable. The publisher's own wiring is
 * covered by the render test alongside it.
 */
describe("the Feed screen has voice actions worth publishing", () => {
  const PUBLISHABLE_PATHS = new Set(["local_handler", "route", "control"]);

  function publishableFor(screen: string) {
    return listKaiActionsForSurface({ screen }).filter(
      (action) =>
        action.execution_target.status === "wired" &&
        PUBLISHABLE_PATHS.has(action.execution_target.path) &&
        action.execution_policy !== "manual_only",
    );
  }

  it("declares accept and reject as reachable on one_feed", () => {
    const ids = new Set(publishableFor("one_feed").map((a) => a.action_id));
    expect(ids.has("connect.accept_request")).toBe(true);
    expect(ids.has("connect.reject_request")).toBe(true);
  });

  it("keeps both behind a confirmation -- accepting is not a bare yes", () => {
    // Accepting a request grants someone a standing relationship, and
    // rejecting one is not undoable from here. Neither should run off a
    // single misheard word.
    for (const id of ["connect.accept_request", "connect.reject_request"]) {
      const action = publishableFor("one_feed").find((a) => a.action_id === id);
      expect(action?.execution_policy, id).toBe("confirm_required");
    }
  });

  it("publishes a non-empty set -- an empty one would be the old bug back", () => {
    // The regression this guards is not "wrong actions" but "no actions at
    // all", which is exactly how the screen behaved before and produced no
    // error anywhere.
    expect(publishableFor("one_feed").length).toBeGreaterThan(0);
  });
});
