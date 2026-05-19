import { describe, expect, it } from "vitest";

import {
  getProfileRiaRefreshLicenseNumber,
  resolveProfileRiaRegulatoryRow,
} from "@/lib/profile/profile-ria-regulatory-row";

describe("resolveProfileRiaRegulatoryRow", () => {
  it("disables the regulatory row while status is loading", () => {
    expect(
      resolveProfileRiaRegulatoryRow({
        loading: true,
        status: null,
        error: null,
      }),
    ).toMatchObject({
      action: "wait",
      title: "Regulatory profile",
      badge: "Checking",
      disabled: true,
    });
  });

  it("routes users without an RIA profile back to onboarding", () => {
    expect(
      resolveProfileRiaRegulatoryRow({
        loading: false,
        status: { exists: false, verification_status: "draft" },
        error: null,
      }),
    ).toMatchObject({
      action: "onboarding",
      badge: "Setup",
      disabled: false,
    });
  });

  it("prefers stored license number for an existing RIA profile", () => {
    const state = resolveProfileRiaRegulatoryRow({
      loading: false,
      status: {
        exists: true,
        verification_status: "verified",
        license_number: "7413463",
        individual_crd: "1111111",
      },
      error: null,
    });

    expect(state).toMatchObject({
      action: "refresh",
      badge: "Update",
      disabled: false,
    });
    expect(state.description).toContain("7413463");
  });

  it("falls back to individual CRD for refresh prefill", () => {
    expect(
      getProfileRiaRefreshLicenseNumber({
        exists: true,
        verification_status: "verified",
        individual_crd: "7265726",
      }),
    ).toBe("7265726");
  });
});
