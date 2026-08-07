/**
 * The dev deployment matches localhost: it does not force the phone screen.
 *
 * The localhost bypass is gated on `resolveAppEnvironment() === "development"` AND
 * the hostname. That environment test cannot be reused for the hosted dev lane: the
 * dev frontend is built with `_APP_ENV=uat` so its behaviour gates replicate UAT
 * exactly, which means it reports "uat" on dev and "uat" on real UAT and cannot
 * separate them. Requiring "development" would refuse dev; accepting "uat" would
 * open real UAT. So dev is matched on hostname alone, and these tests exist to hold
 * that line exactly where it is.
 *
 * The neighbouring hostnames are the whole risk. `one.hushh.ai` and
 * `uat.one.hushh.ai` both END WITH the dev host's registrable domain, so any suffix
 * or substring match would silently open production.
 */

import {
  shouldBypassPhoneMandateForLocalhost,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";

const UNVERIFIED = {
  phoneNumber: null,
  phoneVerified: false,
  hasVault: false,
} as const;

describe("the hosted dev deployment behaves like localhost", () => {
  it("bypasses the mandate on dev.one.hushh.ai", () => {
    expect(shouldBypassPhoneMandateForLocalhost("dev.one.hushh.ai")).toBe(true);
    expect(
      shouldRequirePhoneMandate({ ...UNVERIFIED, hostname: "dev.one.hushh.ai" }),
    ).toBe(false);
  });

  it("still bypasses on a port-suffixed dev host", () => {
    expect(shouldBypassPhoneMandateForLocalhost("dev.one.hushh.ai:443")).toBe(true);
  });

  it("is case-insensitive, because a hostname is", () => {
    expect(shouldBypassPhoneMandateForLocalhost("DEV.One.Hushh.AI")).toBe(true);
  });
});

describe("no other environment is opened", () => {
  it.each([
    ["production", "one.hushh.ai"],
    ["uat", "uat.one.hushh.ai"],
    ["a lookalike subdomain", "dev.one.hushh.ai.evil.example"],
    ["a prefix collision", "notdev.one.hushh.ai"],
    ["a bare registrable domain", "hushh.ai"],
  ])("still requires the mandate on %s", (_label, hostname) => {
    expect(shouldBypassPhoneMandateForLocalhost(hostname)).toBe(false);
    expect(shouldRequirePhoneMandate({ ...UNVERIFIED, hostname })).toBe(true);
  });
});

describe("the localhost path is unchanged", () => {
  it("bypasses on localhost, which resolveAppEnvironment reports as development in tests", () => {
    expect(shouldBypassPhoneMandateForLocalhost("localhost")).toBe(true);
    expect(shouldBypassPhoneMandateForLocalhost("127.0.0.1")).toBe(true);
  });

  it("does not bypass for an unrecognised host", () => {
    expect(shouldBypassPhoneMandateForLocalhost("192.168.1.10")).toBe(false);
    expect(shouldBypassPhoneMandateForLocalhost("")).toBe(false);
    expect(shouldBypassPhoneMandateForLocalhost(null)).toBe(false);
  });
});

describe("a verified phone short-circuits regardless of host", () => {
  it("never requires the mandate once the phone is verified", () => {
    expect(
      shouldRequirePhoneMandate({
        phoneNumber: "+14255551234",
        phoneVerified: true,
        hasVault: false,
        hostname: "one.hushh.ai",
      }),
    ).toBe(false);
  });
});
