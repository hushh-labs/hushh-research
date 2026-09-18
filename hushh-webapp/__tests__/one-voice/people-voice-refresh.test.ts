import { describe, expect, it } from "vitest";

import {
  isPeopleGraphChange,
  VoiceRefreshDeduper,
} from "@/lib/one-voice/people-voice-refresh";

const KEYS = ["connections", "location_people"];

describe("isPeopleGraphChange", () => {
  it("is true only for a committed change that names the people surfaces", () => {
    expect(isPeopleGraphChange("invite_person", { status: "sent", ui_refresh: KEYS })).toBe(true);
    expect(isPeopleGraphChange(null, { status: "accepted", ui_refresh: KEYS })).toBe(true);
    expect(isPeopleGraphChange("decline_connection_request", { status: "declined", ui_refresh: KEYS })).toBe(true);
    expect(isPeopleGraphChange("remove_connection", { status: "removed", ui_refresh: KEYS })).toBe(true);
  });
  it("is false for waits, refusals, no-ops and other surfaces", () => {
    expect(isPeopleGraphChange("invite_person", { status: "confirmation_required", ui_refresh: KEYS })).toBe(false);
    expect(isPeopleGraphChange("invite_person", { status: "already_pending", ui_refresh: KEYS })).toBe(false);
    expect(isPeopleGraphChange("accept_connection_request", { status: "scope_review_required", ui_refresh: KEYS })).toBe(false);
    expect(isPeopleGraphChange("invite_person", { status: "firebase_proof_required" })).toBe(false);
    expect(isPeopleGraphChange("remove_connection", { status: "unverified", ui_refresh: KEYS })).toBe(false);
    expect(isPeopleGraphChange("invite_person", { status: "rejected", ui_refresh: KEYS })).toBe(false);
    expect(isPeopleGraphChange("create_circle", { status: "created", ui_refresh: ["location_circles"] })).toBe(false);
    expect(isPeopleGraphChange("invite_person", null)).toBe(false);
  });
});

describe("VoiceRefreshDeduper", () => {
  it("refreshes once for the two frames the relay sends for one action", () => {
    let t = 1_000;
    const dedupe = new VoiceRefreshDeduper(() => t);
    const first = { status: "sent", ui_refresh: KEYS, request_id: "req-1" };
    // The mirror frame is a different object with the same outcome.
    const mirror = { status: "sent", ui_refresh: KEYS, request_id: "req-1" };
    expect(dedupe.shouldRefresh(first)).toBe(true);
    t += 50;
    expect(dedupe.shouldRefresh(mirror)).toBe(false);
    // A different outcome, or the same one much later, refreshes again.
    expect(dedupe.shouldRefresh({ status: "sent", ui_refresh: KEYS, request_id: "req-2" })).toBe(true);
    t += 60_000;
    expect(dedupe.shouldRefresh({ status: "sent", ui_refresh: KEYS, request_id: "req-1" })).toBe(true);
    expect(dedupe.shouldRefresh(null)).toBe(false);
  });
});
