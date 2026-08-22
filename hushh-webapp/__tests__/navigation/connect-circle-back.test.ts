import { describe, expect, it } from "vitest";

import { resolveTopShellBackAction } from "@/lib/navigation/top-shell-back";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Back, out of a Circle flow hosted on Connect.
 *
 * Circles moved to Connect (#5458) and brought their `?action=` flows with
 * them. The close-in-place branch named one pathname literally, so on Connect
 * a flow fell through to the section-root branch and the back arrow returned
 * the person to wherever they had entered Connect FROM -- out of the workspace
 * entirely, from inside a form.
 *
 * There is no second way out: `CreateCircleFlow` and `JoinCircleFlow` pass no
 * `onBack` to their header, and the header renders the button only when one
 * exists. The shell's arrow is the only control on the screen.
 */
describe("back closes a Circle flow instead of leaving Connect", () => {
  const backFor = (search: string, sectionOrigin?: string | null) =>
    resolveTopShellBackAction({
      pathname: ROUTES.CONNECT,
      searchParams: new URLSearchParams(search),
      sectionOrigin,
    });

  it("returns to the circles list, replacing rather than retracing", () => {
    // A flow is a query-only state on the same screen, never a step in the
    // trail -- the same reasoning the Location agent and the profile panel use.
    for (const action of ["create-circle", "join-circle", "circle-detail"]) {
      const back = backFor(`tab=circles&action=${action}`, "/one/kai");
      expect(back?.href, action).toBe(`${ROUTES.CONNECT}?tab=circles`);
      expect(back?.mode, action).toBe("replace");
    }
  });

  it("ignores a recorded section origin while a flow is open", () => {
    // This is the bug. Connect is a bottom-nav root, so the origin branch used
    // to win and carry the person out of Connect from inside a form.
    const back = backFor("tab=circles&action=create-circle", "/one/profile");
    expect(back?.href).not.toBe("/one/profile");
    expect(back?.href).toContain("tab=circles");
  });

  it("leaves the plain Connect surfaces alone", () => {
    // With no flow open, Connect is a section root and back should still
    // return to where the person came from.
    const fromCircles = backFor("tab=circles", "/one/kai");
    expect(fromCircles?.href).toBe("/one/kai");
    expect(fromCircles?.mode).toBe("push");

    const fromConnections = backFor("tab=all", "/one/kai");
    expect(fromConnections?.href).toBe("/one/kai");
  });

  it("does not treat an unrelated tab's action as a Circle flow", () => {
    const back = backFor("tab=all&action=create-circle", "/one/kai");
    expect(back?.href).toBe("/one/kai");
  });
});
