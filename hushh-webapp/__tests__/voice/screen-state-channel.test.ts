/**
 * A screen's own live state has to survive into the snapshot.
 *
 * Location has published circle_count, pending_request_count, permission_state
 * and data_state every render for months, and Profile publishes
 * phone_verified, pending_consents and a security summary. It reached
 * StructuredScreenContext.screen_metadata and stopped there, because
 * OneVoiceContextSnapshot had no member for it -- so One could name every
 * action on a screen while knowing nothing about the screen.
 *
 * The revision test is the one that matters most. A channel that carries the
 * state but never republishes it is worse than no channel: the model quotes a
 * number it was told once and states it as current.
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildOneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import {
  clearVoiceSurfaceMetadata,
  publishVoiceSurfaceMetadata,
} from "@/lib/voice/voice-surface-metadata";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

function runtime(): AppRuntimeState {
  return {
    auth: { signed_in: true, user_id: "u1" },
    vault: { unlocked: true, token_available: true, token_valid: true },
    route: { pathname: "/one/location", screen: "one_location", subview: null },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: { has_portfolio_data: false },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
  };
}

function publishLocation(screenState: Record<string, unknown>) {
  publishVoiceSurfaceMetadata(
    "route",
    {
      screenId: "one_location",
      title: "Location",
      actions: [],
      controls: [],
      screenState: screenState as Record<string, string | number | boolean | null>,
    },
    { role: "route", routeKey: "/one/location" },
  );
}

afterEach(() => {
  clearVoiceSurfaceMetadata("route");
});

describe("screen_state channel", () => {
  it("carries the surface's published state onto the snapshot", () => {
    publishLocation({ circle_count: 3, permission_state: "granted" });
    const snapshot = buildOneVoiceContextSnapshot({ appRuntimeState: runtime() });

    expect(snapshot.screen_state).toMatchObject({
      circle_count: 3,
      permission_state: "granted",
    });
  });

  it("never carries screenMetadata, which stays browser-local", () => {
    // screenMetadata is a mixed bag: surfaces use it for internal plumbing
    // too. One publishes a raw cache key containing a user id, and a
    // long-standing test asserts that value never reaches the snapshot.
    // Deriving screen_state from it would have broken that invariant for
    // every surface at once, which is exactly what happened on the first
    // attempt at this change.
    publishVoiceSurfaceMetadata(
      "route",
      {
        screenId: "one_location",
        title: "Location",
        actions: [],
        controls: [],
        screenMetadata: { raw_cache_key: "portfolio_data_user_1" },
        screenState: { circle_count: 1 },
      },
      { role: "route", routeKey: "/one/location" },
    );
    const snapshot = buildOneVoiceContextSnapshot({ appRuntimeState: runtime() });

    expect(snapshot.screen_state).toEqual({ circle_count: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("user_1");
  });

  it("drops non-scalars rather than flattening them", () => {
    publishLocation({
      circle_count: 2,
      circles: [{ name: "Family" }],
      nested: { a: 1 },
    });
    const snapshot = buildOneVoiceContextSnapshot({ appRuntimeState: runtime() });

    expect(snapshot.screen_state).toEqual({ circle_count: 2 });
  });

  it("is null when a surface publishes no state of its own", () => {
    publishLocation({});
    const snapshot = buildOneVoiceContextSnapshot({ appRuntimeState: runtime() });

    expect(snapshot.screen_state).toBeNull();
  });

  it("moves the ui revision when only the state changed", () => {
    // The whole channel is inert without this. Modules and controls are
    // identical when a pending count goes 0 -> 3, so if screen state is not a
    // revision input the snapshot is byte-identical, nothing republishes, and
    // the model keeps answering with the count it was first given.
    publishLocation({ pending_request_count: 0 });
    const before = buildOneVoiceContextSnapshot({ appRuntimeState: runtime() });

    clearVoiceSurfaceMetadata("route");
    publishLocation({ pending_request_count: 3 });
    const after = buildOneVoiceContextSnapshot({ appRuntimeState: runtime() });

    expect(after.screen_state).toMatchObject({ pending_request_count: 3 });
    expect(after.revisions.ui).not.toBe(before.revisions.ui);
  });
});
