import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

import { OneOnboardingCapabilityClient } from "@/app/one/setup/[capability]/one-onboarding-capability-client";

describe("OneOnboardingCapabilityClient compatibility redirect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects a legacy capability URL to its static setup workspace", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="location" />);

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup/location");
    });
  });

  it("contains an unknown capability at the setup hub", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="pkm" />);

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup");
    });
  });
});
