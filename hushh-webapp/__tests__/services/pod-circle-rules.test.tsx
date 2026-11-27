import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { ApiService } from "@/lib/services/api-service";
import {
  buildDelegationSubkeyRef,
  isForbiddenSovereignScope,
  validateScopePatternInput,
} from "@/lib/services/pod-circle-rules";
import { CircleAutoApprovePanel } from "@/components/connections/circle-auto-approve-panel";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    ownerPodRequest: vi.fn(),
  },
}));

vi.mock("@/lib/morphy-ux/morphy", async (original) => ({
  ...(await original<object>()),
  morphyToast: { error: vi.fn(), success: vi.fn() },
}));

describe("Stage 2b Dual-Lock Circle Auto-Approve & NL Filter Box", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner-stage2b");
  });

  it("blocks sovereign Vault scopes, contacts, and root wildcards on the client", () => {
    for (const forbidden of [
      "*",
      "vault.*",
      "vault.secrets",
      "identity.ssn",
      "finance.holdings",
      "wallet.pan",
      "contacts",
      "contacts.*",
    ]) {
      expect(isForbiddenSovereignScope(forbidden)).toBe(true);
      expect(validateScopePatternInput(forbidden)).toMatch(/protected Sovereign Vault/i);
    }

    expect(isForbiddenSovereignScope("travel.itinerary.*")).toBe(false);
    expect(validateScopePatternInput("travel.itinerary.*")).toBeNull();
    expect(buildDelegationSubkeyRef("trusted", ["travel.itinerary.*"])).toBe(
      "subkey_trusted_travel.itinerary_v1",
    );
  });

  it("renders rules, rejects forbidden scopes inline, saves an NL filter rule, toggles, and deletes", async () => {
    vi.mocked(ApiService.ownerPodRequest)
      // Initial list
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rules: [],
            recentReceipts: [],
            sessionOnlyLockdown: false,
            masterVaultKeyLeavesDevice: false,
          }),
          { status: 200 },
        ),
      )
      // Save rule
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rule: {
              ruleId: "rule_travel_000001",
              circleId: "trusted",
              label: "Flight confirmations",
              scopePatterns: ["travel.itinerary.*"],
              nlPolicyFilter:
                "Auto-share upcoming flight and hotel confirmations; never share account balances",
              delegationSubkeyRef: "subkey_trusted_travel.itinerary_v1",
              enabled: true,
              dailyCap: 10,
              requireConfidence: 0.85,
              createdAtMs: 1700000000000,
              updatedAtMs: 1700000000000,
            },
          }),
          { status: 200 },
        ),
      )
      // Toggle off
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rule: {
              ruleId: "rule_travel_000001",
              circleId: "trusted",
              label: "Flight confirmations",
              scopePatterns: ["travel.itinerary.*"],
              nlPolicyFilter:
                "Auto-share upcoming flight and hotel confirmations; never share account balances",
              delegationSubkeyRef: "subkey_trusted_travel.itinerary_v1",
              enabled: false,
              dailyCap: 10,
              requireConfidence: 0.85,
              createdAtMs: 1700000000000,
              updatedAtMs: 1700000001000,
            },
          }),
          { status: 200 },
        ),
      )
      // Delete rule
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true, ruleId: "rule_travel_000001" }), {
          status: 200,
        }),
      );

    render(<CircleAutoApprovePanel />);

    const panel = await screen.findByTestId("circle-auto-approve-panel");
    expect(panel).toHaveTextContent("Master Vault Key stays on your device");

    // Open builder
    fireEvent.click(screen.getByRole("button", { name: "Add Circle rule" }));
    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Flight confirmations" },
    });

    // Try forbidden sovereign scope first -> inline error, no API write.
    fireEvent.change(screen.getByLabelText("Lock 1: Allowed scope ceiling"), {
      target: { value: "vault.secrets.*" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(await screen.findByTestId("circle-rule-error")).toHaveTextContent(
      /protected Sovereign Vault/i,
    );
    expect(ApiService.ownerPodRequest).toHaveBeenCalledTimes(1);

    // Fix scope ceiling + enter Natural-Language filter -> saves cleanly.
    fireEvent.change(screen.getByLabelText("Lock 1: Allowed scope ceiling"), {
      target: { value: "travel.itinerary.*" },
    });
    fireEvent.change(screen.getByLabelText("Lock 2: Natural-language filter (optional)"), {
      target: {
        value:
          "Auto-share upcoming flight and hotel confirmations; never share account balances",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    const row = await screen.findByTestId("circle-rule-row-rule_travel_000001");
    expect(row).toHaveTextContent("Flight confirmations");
    expect(row).toHaveTextContent("travel.itinerary.*");
    expect(row).toHaveTextContent("never share account balances");

    // 1-tap toggle off
    fireEvent.click(screen.getByRole("switch", { name: "Toggle Flight confirmations" }));
    await waitFor(() => {
      expect(ApiService.ownerPodRequest).toHaveBeenCalledWith(
        "circle-rules/rule_travel_000001/toggle",
        expect.objectContaining({ method: "POST" }),
        false,
        undefined,
        undefined,
        expect.any(Function),
      );
    });

    // 1-tap remove
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(screen.queryByTestId("circle-rule-row-rule_travel_000001")).not.toBeInTheDocument();
    });
  });

  it("displays lockdown pause notice when session_only_lockdown is enabled", async () => {
    vi.mocked(ApiService.ownerPodRequest).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rules: [],
          recentReceipts: [],
          sessionOnlyLockdown: true,
          masterVaultKeyLeavesDevice: false,
        }),
        { status: 200 },
      ),
    );

    render(<CircleAutoApprovePanel />);
    const banner = await screen.findByTestId("circle-rules-lockdown-banner");
    expect(banner).toHaveTextContent("Session-only lockdown is on");
  });
});
