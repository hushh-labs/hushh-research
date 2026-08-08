import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RiaClaimPage from "@/app/ria/claim/page";

const {
  replace,
  claimLookupMock,
  claimVerifyMock,
  claimOtpStartMock,
  claimCompleteMock,
  refreshPersonaMock,
} = vi.hoisted(() => ({
  replace: vi.fn(),
  claimLookupMock: vi.fn(),
  claimVerifyMock: vi.fn(),
  claimOtpStartMock: vi.fn(),
  claimCompleteMock: vi.fn(),
  refreshPersonaMock: vi.fn().mockResolvedValue(undefined),
}));

// The number arrives via ?phone= from register-phone; the account record in
// useAuth is deliberately null — the exact state where the old client-side
// gate produced a second OTP. The server alone decides.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams("phone=8015551234"),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      uid: "claimant",
      phoneNumber: null,
      getIdToken: vi.fn().mockResolvedValue("token"),
    },
    phoneNumber: null,
    loading: false,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: null, vaultOwnerToken: null }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({ refresh: refreshPersonaMock }),
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onPersonaStateChanged: vi.fn() },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: vi.fn().mockResolvedValue({ setupCapabilityIds: ["ria"] }),
    syncSetupCapabilities: vi.fn().mockResolvedValue(undefined),
    isSetupResolved: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("@/components/app-ui/fullscreen-flow-shell", () => ({
  FullscreenFlowShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));

vi.mock("@/lib/services/ria-service", () => {
  class RiaApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = "RiaApiError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    RiaApiError,
    RiaService: {
      claimLookup: claimLookupMock,
      claimVerify: claimVerifyMock,
      claimOtpStart: claimOtpStartMock,
      claimComplete: claimCompleteMock,
      saveRegulatorProfile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { RiaApiError } from "@/lib/services/ria-service";

const lookupResult = {
  outcome: "single_person",
  firm: {
    crd: 800001,
    name: "EXAMPLE ADVISORS LLC",
    city: "AUSTIN",
    state: "TX",
    phone: null,
    aum: null,
  },
  firms: [],
  candidates: [
    { individual_crd: 123, name: "JANE DOE", branch_city: "AUSTIN", branch_state: "TX" },
  ],
  current_adviser_count: 1,
};

const verifyResult = {
  claim_ticket: "ticket-1",
  provisional: false,
  profile_verified: true,
  roster_unlocked: true,
  roster: null,
};

const completeResult = {
  status: "claimed",
  claim_type: "individual",
  verification_level: "verified",
  profile_verified: true,
  provisional: false,
  profile: {
    ria_profile_id: "rp-1",
    user_id: "claimant",
    display_name: "Jane Doe",
    verification_status: "verified",
    firm_name: "EXAMPLE ADVISORS LLC",
  },
  facts: null,
};

async function renderToFoundStep() {
  render(<RiaClaimPage />);
  const continueButton = await screen.findByRole("button", { name: "Continue" });
  return continueButton;
}

describe("RiaClaimPage beginClaim — single OTP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimLookupMock.mockResolvedValue(lookupResult);
    claimCompleteMock.mockResolvedValue(completeResult);
    claimOtpStartMock.mockResolvedValue({
      eligible: true,
      verification_id: "v-1",
      code_length: 5,
      phone_masked: "(•••) •••-1234",
    });
  });

  it("attempts the tokenless verify first and skips the code step on success", async () => {
    claimVerifyMock.mockResolvedValue(verifyResult);
    const continueButton = await renderToFoundStep();

    fireEvent.click(continueButton);

    await waitFor(() => expect(screen.getByText("Profile claimed")).toBeInTheDocument());
    expect(claimVerifyMock).toHaveBeenCalledTimes(1);
    expect(claimVerifyMock).toHaveBeenCalledWith("token", {
      phone: "8015551234",
      claim_type: "individual",
      firm_crd: 800001,
      individual_crd: 123,
    });
    expect(claimOtpStartMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Verify the number")).not.toBeInTheDocument();
  });

  it("falls through to the passcode when the server answers 422 CLAIM_PROOF_REQUIRED", async () => {
    claimVerifyMock.mockRejectedValue(
      new RiaApiError("Proof required", 422, "CLAIM_PROOF_REQUIRED"),
    );
    const continueButton = await renderToFoundStep();

    fireEvent.click(continueButton);

    await waitFor(() => expect(screen.getByText("Verify the number")).toBeInTheDocument());
    expect(claimVerifyMock).toHaveBeenCalledTimes(1);
    expect(claimOtpStartMock).toHaveBeenCalledTimes(1);
    expect(claimCompleteMock).not.toHaveBeenCalled();
  });

  it("falls through to the passcode on a network error instead of dead-ending", async () => {
    claimVerifyMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const continueButton = await renderToFoundStep();

    fireEvent.click(continueButton);

    await waitFor(() => expect(screen.getByText("Verify the number")).toBeInTheDocument());
    expect(claimOtpStartMock).toHaveBeenCalledTimes(1);
  });
});
