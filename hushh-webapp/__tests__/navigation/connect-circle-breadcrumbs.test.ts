import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Circles moved from the Location agent to Connect (#5458), so the shell has
 * to place them. Without this the crumb reads "One > Connect" while a create
 * form is on screen, and its back arrow leaves the workspace entirely instead
 * of closing the flow.
 */
describe("Connect circle flows get their own crumb", () => {
  const crumbFor = (search: string) =>
    resolveTopShellBreadcrumb(ROUTES.CONNECT, new URLSearchParams(search));

  it("names the flow and offers a back that closes it", () => {
    const crumb = crumbFor("tab=circles&action=create-circle");

    expect(crumb?.items?.map((item) => item.label)).toEqual([
      "Create a Circle",
    ]);
    expect(crumb?.backLabel).toBe("Back to Circles");
    // Back to the list, not out of Connect.
    expect(crumb?.backHref).toBe(`${ROUTES.CONNECT}?tab=circles`);
  });

  it("names joining and opening a circle too", () => {
    expect(
      crumbFor("tab=circles&action=join-circle")?.items?.at(-1)?.label,
    ).toBe("Join a Circle");
    expect(
      crumbFor("tab=circles&action=circle-detail&circleId=c1")?.items?.at(-1)
        ?.label,
    ).toBe("Circle");
  });

  it("names the tab explicitly in the back href", () => {
    // The App Router refuses a navigation whose only change is that the whole
    // query string disappears, so a bare `/one/connect` back href would be a
    // dead press from `?tab=circles&action=…`.
    for (const action of ["create-circle", "join-circle", "circle-detail"]) {
      const circleId = action === "circle-detail" ? "&circleId=c1" : "";
      expect(
        crumbFor(`tab=circles&action=${action}${circleId}`)?.backHref,
      ).toContain("tab=circles");
    }
  });

  it("leaves the plain Connect crumb alone", () => {
    // The list itself is still level two, and its back still leaves for home.
    const list = crumbFor("tab=circles");
    expect(list?.items?.map((item) => item.label)).toEqual(["One"]);
    expect(list?.backHref).toBe(ROUTES.ONE_HOME);

    const connections = crumbFor("tab=all");
    expect(connections?.items?.map((item) => item.label)).toEqual(["One"]);
  });

  it("ignores an action it does not recognise", () => {
    const crumb = crumbFor("tab=circles&action=nonsense");
    expect(crumb?.items?.map((item) => item.label)).toEqual(["One"]);
  });
});
