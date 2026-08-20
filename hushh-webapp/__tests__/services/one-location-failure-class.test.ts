import { describe, expect, it } from "vitest";

import { oneLocationFailureClass } from "@/app/one/location/page";

/**
 * These cases exist because the classifier was wrong in a way that hid itself.
 *
 * It previously returned "permission" for any message containing the bare word
 * "location". In the One Location surface almost every message does, so over 30
 * days of production 965 events -- 77% of all location retries, and the single
 * largest signal on the surface -- reported a cause that was usually not the
 * cause. Decryption failures, missing envelopes and revoked grants all arrived
 * labelled as if the user had declined a GPS prompt, which made the real
 * problem invisible for as long as anyone cared to look.
 */
describe("oneLocationFailureClass", () => {
  it("does not call every location-worded failure a permission problem", () => {
    expect(
      oneLocationFailureClass(new Error("Could not load location")),
    ).toBe("unknown");
    expect(
      oneLocationFailureClass(
        new Error("The owner has not published an encrypted location envelope yet."),
      ),
    ).toBe("encryption");
    expect(
      oneLocationFailureClass(new Error("Location share has expired")),
    ).toBe("unknown");
  });

  it("classifies real permission failures by the platforms' own vocabulary", () => {
    expect(
      oneLocationFailureClass(new Error("User denied Geolocation")),
    ).toBe("permission");
    expect(
      oneLocationFailureClass(new Error("Location permission not granted")),
    ).toBe("permission");
    expect(
      oneLocationFailureClass(new Error("Not authorized to use location")),
    ).toBe("permission");
  });

  it("classifies decryption ahead of permission", () => {
    // Ordering matters: this message contains both "location" and "decrypt",
    // and the actionable fact is that decryption failed.
    expect(
      oneLocationFailureClass(new Error("Failed to decrypt location envelope")),
    ).toBe("encryption");
    expect(
      oneLocationFailureClass(new Error("Recipient key unavailable")),
    ).toBe("encryption");
  });

  it("keeps the transport classes it already got right", () => {
    expect(oneLocationFailureClass(new Error("network request failed"))).toBe(
      "network",
    );
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(oneLocationFailureClass(aborted)).toBe("aborted");
  });
});
