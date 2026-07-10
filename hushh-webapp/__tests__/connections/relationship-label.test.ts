import { describe, expect, it } from "vitest";

import { relationshipCta } from "@/lib/connections/relationship-label";

describe("relationshipCta", () => {
  it("offers Connect when there is no relationship", () => {
    expect(relationshipCta("none")).toEqual({ label: "Connect", disabled: false, action: "connect" });
  });
  it("shows Requested and disables when outgoing pending", () => {
    expect(relationshipCta("pending_outgoing")).toEqual({ label: "Requested", disabled: true, action: "none" });
  });
  it("prompts Respond when incoming pending", () => {
    expect(relationshipCta("pending_incoming")).toEqual({ label: "Respond", disabled: false, action: "respond" });
  });
  it("shows Connected and disables when connected", () => {
    expect(relationshipCta("connected")).toEqual({ label: "Connected", disabled: true, action: "none" });
  });
});
