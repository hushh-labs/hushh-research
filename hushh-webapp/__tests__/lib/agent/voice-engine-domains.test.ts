import { describe, expect, it } from "vitest";

import {
  VOICE_ENGINE_DOMAINS,
  resolveEffectiveDisabledDomains,
} from "@/lib/agent/voice-engine-domains";

describe("VOICE_ENGINE_DOMAINS", () => {
  it("supports exactly Location and Connections today", () => {
    // Pinned deliberately. Turning a domain back on is a one-line change and
    // should be, but it should be a decision somebody made on purpose rather
    // than something that drifts in unnoticed.
    expect(
      VOICE_ENGINE_DOMAINS.filter((domain) => domain.enforced).map(
        (domain) => domain.key,
      ),
    ).toEqual(["location", "connections"]);
  });

  it("gives every domain a label, so an unenforced one still reads as a real thing", () => {
    for (const domain of VOICE_ENGINE_DOMAINS) {
      expect(domain.label.trim().length).toBeGreaterThan(0);
      expect(domain.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("resolveEffectiveDisabledDomains", () => {
  it("drops a domain that no longer has a switch", () => {
    // The trap this exists for: Consent Center and Connected Systems used to
    // be switchable, so somebody may have a stored key for them. The server
    // has no notion of "enforced" and blocks any recognised key it receives,
    // so without this filter that person keeps voice off there permanently
    // with no switch left to undo it.
    expect(
      resolveEffectiveDisabledDomains(["consent", "connected_systems"]),
    ).toEqual([]);
  });

  it("keeps a domain that is still switchable", () => {
    expect(resolveEffectiveDisabledDomains(["location"])).toEqual(["location"]);
    expect(resolveEffectiveDisabledDomains(["connections"])).toEqual([
      "connections",
    ]);
  });

  it("keeps the supported keys while dropping the rest, in one list", () => {
    expect(
      resolveEffectiveDisabledDomains([
        "location",
        "email",
        "connections",
        "kyc",
        "finance",
      ]),
    ).toEqual(["location", "connections"]);
  });

  it("ignores a key that was never a domain at all", () => {
    expect(resolveEffectiveDisabledDomains(["not_a_domain", ""])).toEqual([]);
  });

  it("leaves an empty list alone rather than inventing a restriction", () => {
    // These preferences are restrictions on an already-authorized capability,
    // so the failure direction that matters is adding one nobody asked for.
    expect(resolveEffectiveDisabledDomains([])).toEqual([]);
  });

  it("never returns a key that has no switch to undo it", () => {
    // The property behind the specific cases above: whatever goes in, nothing
    // survives that the person cannot see and manage in the panel.
    const enforced = new Set(
      VOICE_ENGINE_DOMAINS.filter((domain) => domain.enforced).map(
        (domain) => domain.key,
      ),
    );
    const everyKey = VOICE_ENGINE_DOMAINS.map((domain) => domain.key);

    for (const key of resolveEffectiveDisabledDomains(everyKey)) {
      expect(enforced.has(key)).toBe(true);
    }
  });
});
