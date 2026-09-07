import { afterEach, expect, it } from "vitest";
import {
  publishValidatedAuthSessionOwner,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import {
  canReusePrewarmedRelay,
  type PrewarmedGeminiRelay,
} from "@/lib/voice/prewarmed-relay";

afterEach(() => publishValidatedAuthSessionOwner(null));
function ticket(
  owner: string | null,
  tier = "signed_locked",
): PrewarmedGeminiRelay {
  publishValidatedAuthSessionOwner(owner);
  return {
    relayUrl: "wss://synthetic.example",
    expiresAtMs: 200,
    snapshotId: "synthetic",
    accessTier: tier,
    ownerUserId: owner,
    ownerSnapshot: snapshotValidatedAuthSessionOwner(),
  };
}
it("rejects same-tier owner replacement and logout/login generations", () => {
  const cached = ticket("owner-a");
  expect(canReusePrewarmedRelay(cached, "signed_locked", "owner-a", 100)).toBe(
    true,
  );
  publishValidatedAuthSessionOwner("owner-b");
  expect(canReusePrewarmedRelay(cached, "signed_locked", "owner-b", 100)).toBe(
    false,
  );
  publishValidatedAuthSessionOwner("owner-a");
  expect(canReusePrewarmedRelay(cached, "signed_locked", "owner-a", 100)).toBe(
    false,
  );
});
it("rejects expired and guest-to-signed cache reuse", () => {
  const cached = ticket(null, "anon_onboarding");
  expect(canReusePrewarmedRelay(cached, "anon_onboarding", null, 100)).toBe(
    true,
  );
  expect(canReusePrewarmedRelay(cached, "anon_onboarding", null, 200)).toBe(
    false,
  );
  publishValidatedAuthSessionOwner("owner-a");
  expect(canReusePrewarmedRelay(cached, "anon_onboarding", null, 100)).toBe(
    false,
  );
});
