/**
 * Phone-mandate host policy: localhost is exempt, narrowly. The dev deployment
 * NEVER is. These tests are the trip-wire on both halves.
 *
 * `dev.one.hushh.ai` used to be in the bypass set, and that produced a dead
 * loop a person could not escape through the product (observed 2026-08-19 with
 * a freshly re-created account): the client never asked for a phone while the
 * SERVER kept requiring `phone_verified is True` before recording a cloud, so
 * the save 409'd "verify your phone first" with no reachable way to comply.
 * Dev must ask, exactly like production; its server carries the
 * fictitious-number lane (+1 555 0100-0199, no SMS, no captcha) so the screen
 * is cheap to pass there.
 *
 * Localhost stays exempt for one concrete reason: Firebase phone auth's
 * reCAPTCHA cannot complete on localhost (known auth limitation,
 * founder-verified 2026-08-20), so a forced screen there cannot be passed with
 * a real number. The exemption grants nothing server-side.
 */

import { vi } from "vitest";

import {
  shouldBypassPhoneMandateForLocalhost,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";

const UNVERIFIED = {
  phoneNumber: null,
  phoneVerified: false,
  hasVault: false,
} as const;

describe("the dev deployment is NEVER exempt (the dead-loop regression)", () => {
  it.each(["development", "uat", "production"])(
    "requires the mandate on dev.one.hushh.ai under app env %s",
    (appEnv) => {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", appEnv);
      expect(shouldBypassPhoneMandateForLocalhost("dev.one.hushh.ai")).toBe(false);
      expect(
        shouldRequirePhoneMandate({ ...UNVERIFIED, hostname: "dev.one.hushh.ai" }),
      ).toBe(true);
    },
  );

  it("is not fooled by port or case variants of the dev host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    expect(shouldBypassPhoneMandateForLocalhost("dev.one.hushh.ai:443")).toBe(false);
    expect(shouldBypassPhoneMandateForLocalhost("DEV.One.Hushh.AI")).toBe(false);
  });
});

describe("no hosted environment is exempt", () => {
  it.each([
    ["production", "one.hushh.ai"],
    ["uat", "uat.one.hushh.ai"],
    ["a lookalike subdomain", "localhost.evil.example"],
    ["a bare registrable domain", "hushh.ai"],
    ["a LAN address", "192.168.1.10"],
    ["an empty host", ""],
  ])("still requires the mandate on %s", (_label, hostname) => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    expect(shouldBypassPhoneMandateForLocalhost(hostname)).toBe(false);
    expect(shouldRequirePhoneMandate({ ...UNVERIFIED, hostname })).toBe(true);
  });
});

describe("localhost is exempt, gated on the development environment", () => {
  it("bypasses on localhost and 127.0.0.1 in development", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    expect(shouldBypassPhoneMandateForLocalhost("localhost")).toBe(true);
    expect(shouldBypassPhoneMandateForLocalhost("127.0.0.1")).toBe(true);
    expect(
      shouldRequirePhoneMandate({ ...UNVERIFIED, hostname: "localhost" }),
    ).toBe(false);
  });

  it("does not bypass localhost outside the development environment", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(shouldBypassPhoneMandateForLocalhost("localhost")).toBe(false);
  });
});

describe("verification releases the mandate everywhere", () => {
  it("never requires the mandate once the backend confirmed the phone", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(
      shouldRequirePhoneMandate({
        phoneNumber: null,
        phoneVerified: true,
        hasVault: false,
        hostname: "one.hushh.ai",
      }),
    ).toBe(false);
  });

  it("never requires the mandate once Firebase carries a phone number", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(
      shouldRequirePhoneMandate({
        phoneNumber: "+14255551234",
        phoneVerified: false,
        hasVault: false,
        hostname: "one.hushh.ai",
      }),
    ).toBe(false);
  });

  it("keeps the one deliberate route exemption (RIA onboarding), and only that", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(
      shouldRequirePhoneMandate({ ...UNVERIFIED, pathname: "/ria/onboarding" }),
    ).toBe(false);
    expect(
      shouldRequirePhoneMandate({ ...UNVERIFIED, pathname: "/one/setup/cloud" }),
    ).toBe(true);
  });

  it("honours the explicit vault-holder exemption", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(
      shouldRequirePhoneMandate({
        ...UNVERIFIED,
        hasVault: true,
        exemptVaultUsers: true,
      }),
    ).toBe(false);
  });
});
