// Why a map-anchored sheet must not paint a scrim, and why no lane may ship
// the fabricated-people fixture.
//
// Both were reported the same way -- "it is not working" -- and both were
// really a control that is plainly visible and cannot respond:
//
//   * The nearby check-in sheet was `modal`, so Radix rendered
//     `fixed inset-0 z-[711] touch-none` over the WHOLE screen. The Location
//     map's close X, Locate and Check-in controls sit at z-30, so they stayed
//     perfectly visible through a 22%-black blur and swallowed every tap. On a
//     phone that is indistinguishable from a broken close button.
//   * The map's demo fixture is correctly gated in code, but the UAT deploy
//     lane passed `_LOCATION_MAP_DEMO=true` and put fifty fabricated people on
//     the map every reviewer, tester and demo audience sees.
//
// The sheet primitive is asserted by rendering it, because it is cheap and real.
// The check-in sheet's own wiring and the deploy lanes are asserted as source
// contracts: NearbyCheckInSheet is a 2000-line module whose render needs the
// whole location service surface, and a workflow has no render at all.

import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Sheet, SheetContent } from "@/components/ui/sheet";

const REPO_ROOT = path.join(process.cwd(), "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

afterEach(cleanup);

describe("sheet scrim is opt-out", () => {
  it("paints the blocking scrim for a modal sheet", () => {
    render(
      <Sheet modal open>
        <SheetContent side="bottom">Body</SheetContent>
      </Sheet>,
    );

    // The default is correct for an ordinary modal sheet: it IS the whole task,
    // and everything behind it should be inert. This is also the exact shape
    // the check-in sheet used to have, and the layer it put over the map.
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
  });

  it("renders no scrim at all when a modal surface opts out", () => {
    // Belt and braces. Radix already skips the overlay for a non-modal root, so
    // `modal={false}` alone fixes the map today. `showOverlay={false}` makes the
    // guarantee survive someone later re-enabling `modal` -- for focus trapping,
    // say -- without noticing that it also re-covers the host screen.
    render(
      <Sheet modal open>
        <SheetContent side="bottom" showOverlay={false}>
          Body
        </SheetContent>
      </Sheet>,
    );

    // Not "transparent" -- absent. A transparent `inset-0 touch-none` layer
    // still eats every tap underneath it, which is the exact bug.
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

  it("keeps a 44px hit target on the close button without resizing it", () => {
    render(
      <Sheet open>
        <SheetContent side="bottom">Body</SheetContent>
      </Sheet>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    // Visible circle unchanged at 32px (p-2 + size-4)...
    expect(close).toHaveClass("p-2");
    // ...while the pressable region extends 6px on every side to reach 44px.
    expect(close).toHaveClass("after:absolute", "after:-inset-1.5");
  });
});

describe("nearby check-in sheet leaves the map operable", () => {
  const source = readSource(
    "components/one-location/nearby-check-in/nearby-check-in-sheet.tsx",
  );

  it("is not modal and paints no scrim over the map", () => {
    expect(source).toContain("<Sheet modal={false}");
    expect(source).toContain("showOverlay={false}");
    // The precise regression: `<Sheet modal ...>` is what covered the map's own
    // controls with an inert full-screen layer.
    expect(source).not.toMatch(/<Sheet\s+modal\s+/);
  });

  it("does not dismiss when the map behind it is panned", () => {
    // Without a scrim, every pan and pinch used to find a place is an "outside"
    // interaction. Letting those close the sheet would end the task mid-answer.
    expect(source).toContain("onInteractOutside");
    expect(source).toContain("onPointerDownOutside");
  });

  it("stops short of the map header instead of taking 85dvh", () => {
    // With the controls behind it live again, the sheet itself must not be the
    // thing covering them.
    expect(source).toContain(
      "max-h-[calc(100dvh-env(safe-area-inset-top)-8.5rem-var(--kb-height,0px))]",
    );
  });
});

describe("no deploy lane ships the fabricated-people map fixture", () => {
  // Guarding production alone was not enough -- UAT is the frontend every
  // reviewer, tester and demo audience sees, and the backend the store builds
  // point at. A person cannot tell a fixture from a person.
  const workflows = path.join(REPO_ROOT, ".github/workflows");

  it("passes _LOCATION_MAP_DEMO=false everywhere it is passed at all", async () => {
    const { readdirSync } = await import("node:fs");
    const offenders = readdirSync(workflows)
      .filter((name) => name.endsWith(".yml"))
      .filter((name) =>
        readFileSync(path.join(workflows, name), "utf8").includes(
          "_LOCATION_MAP_DEMO=true",
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps the Cloud Build substitution defaulting to false", () => {
    const cloudbuild = readFileSync(
      path.join(REPO_ROOT, "deploy/frontend.cloudbuild.yaml"),
      "utf8",
    );
    expect(cloudbuild).toMatch(/_LOCATION_MAP_DEMO:\s*"false"/);
  });
});
