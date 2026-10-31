import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  // Line endings normalised, because this checkout carries CRLF and every
  // assertion below spans more than one line.
  return readFileSync(join(process.cwd(), relativePath), "utf8")
    .split("\r\n")
    .join("\n");
}

/**
 * The file with its comments removed.
 *
 * The handler explains at length WHY it skips a product-managed Circle, and
 * that explanation names the very thing these assertions forbid. Matching raw
 * source would fail on the comment that exists to stop the bug coming back.
 */
function code(relativePath: string): string {
  return source(relativePath)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/**
 * Location onboarding's circle-invite step must not offer a Circle that has no
 * invite code.
 *
 * The step reuses "the first Circle you own" so re-entering onboarding never
 * spawns duplicates. Two Circles now arrive without being asked for -- the SMS
 * Circle, and Trusted the moment a connection is accepted -- and both routinely
 * predate this screen, so "the first Circle you own" became one of them.
 *
 * Neither has a code. A Circle holding everyone you are connected to must not
 * be shareable by a link, so `create_invite_code` refuses it with
 * LOCATION_CIRCLE_SYSTEM_NO_CODE, and the invite step failed with nothing on
 * screen explaining why.
 *
 * Every test that exercises this screen mocks `onPrepareOnboardingCircleInvite`,
 * so none of them can see the picker. This reads it.
 */
describe("onboarding's circle invite never picks a Circle the product manages", () => {
  const page = code("app/one/location/page.tsx");
  const handler = page.slice(
    page.indexOf("handlePrepareOnboardingCircleInvite"),
    page.indexOf("handleShareOnboardingCircleInvite"),
  );

  it("filters product-managed Circles out before choosing one", () => {
    expect(handler).toContain("const shareable = circles.filter(");
  });

  it("chooses from the filtered set, never from the raw list", () => {
    expect(handler).toContain("shareable.find(");
    expect(handler).toContain("shareable[0]?.id");
    // The shape this replaced reached past ownership AND past the product's
    // own Circles in one step.
    expect(handler).not.toContain("circles[0]?.id");
  });

  it("asks both questions, because Trusted answers only one of them", () => {
    // Trusted is deliberately NOT `is_system` -- migration 163 carries the
    // reasoning -- so a filter on the flag alone lets it straight through.
    expect(handler).toContain("!circle.systemKind");
    expect(handler).toContain("!circle.isSystem");
  });

  it("still creates one when the person has no shareable Circle yet", () => {
    // The filter must narrow the reuse, not remove the fallback: a brand-new
    // account owns only Trusted and the SMS Circle, and still needs a code.
    expect(handler).toContain("OneLocationService.createNamedCircle({");
    expect(handler).toContain("targetCircleId = null;");
  });

  it("reads a real slice of the page, so these assertions cannot pass vacuously", () => {
    expect(handler.length).toBeGreaterThan(400);
    expect(handler).toContain("OneLocationService.listCircles(vaultOwnerToken)");
  });
});
