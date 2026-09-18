/**
 * "This circle" reaches the relay as one typed id, never as prompt text.
 *
 * The Circle detail screen publishes `activeCircleId`; the frame builder
 * forwards it as `active_circle_id` only when it is a canonical id, and it
 * never lands in `screen_state` (which is rendered into the model's prompt).
 */
import { describe, expect, it } from "vitest";

import {
  buildAppContextFrame,
  collectActiveCircleId,
  collectScreenState,
} from "@/lib/one-voice/app-context";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const FAMILY = "11111111-1111-4111-8111-111111111111";

function surface(overrides: Partial<VoiceSurfaceMetadata> = {}): VoiceSurfaceMetadata {
  return {
    screenId: "one_location_circle",
    title: "Circle",
    purpose: "One circle.",
    actions: [],
    availableActions: [],
    ...overrides,
  } as VoiceSurfaceMetadata;
}

describe("active circle in app_context", () => {
  it("forwards a canonical circle id as its own typed field", () => {
    const frame = buildAppContextFrame({
      runtime: null,
      pathname: "/one/location",
      surface: surface({ activeCircleId: FAMILY }),
    });
    expect(frame.active_circle_id).toBe(FAMILY);
    expect(frame.screen_id).toBe("one_location_circle");
  });

  it("never puts the id into screen_state", () => {
    const meta = surface({ activeCircleId: FAMILY, screenState: { member_count: 3 } });
    expect(collectScreenState(null, meta)).toEqual({ member_count: 3 });
    const frame = buildAppContextFrame({ runtime: null, pathname: "/one/location", surface: meta });
    expect(JSON.stringify(frame.screen_state)).not.toContain(FAMILY);
  });

  it("sends null when the screen is not about one circle", () => {
    const frame = buildAppContextFrame({
      runtime: null,
      pathname: "/one",
      surface: surface({ screenId: "one_home" }),
    });
    expect(frame.active_circle_id).toBeNull();
    expect(buildAppContextFrame({ runtime: null, pathname: "/one", surface: null }).active_circle_id).toBeNull();
  });

  it("drops anything that is not a canonical id rather than sending a name", () => {
    expect(collectActiveCircleId(surface({ activeCircleId: "Family" }))).toBeNull();
    expect(collectActiveCircleId(surface({ activeCircleId: " " }))).toBeNull();
    expect(collectActiveCircleId(surface({ activeCircleId: `${FAMILY}x` }))).toBeNull();
    expect(collectActiveCircleId(surface({ activeCircleId: FAMILY.toUpperCase() }))).toBe(
      FAMILY.toUpperCase(),
    );
  });
});
