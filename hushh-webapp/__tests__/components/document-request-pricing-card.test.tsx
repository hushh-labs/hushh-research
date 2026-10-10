import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: "owner-token" as string | null, owner: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token }) }));
vi.mock("@/lib/services/drive-request-pricing-service", () => ({
  DriveRequestPricingService: { owner: state.owner, save: state.save },
}));

import { DocumentRequestPricingCard } from "@/components/consent/document-request-pricing-card";
import { ApiError } from "@/lib/services/api-client";

describe("owner Drive request price", () => {
  beforeEach(() => {
    state.token = "owner-token";
    state.owner.mockReset().mockResolvedValue({ enabled: false, amountCents: 1000, version: 4 });
    state.save.mockReset().mockResolvedValue({ enabled: true, amountCents: 2500, version: 5 });
  });

  it("uses the $10 default until the owner saves a future-request price", async () => {
    render(<DocumentRequestPricingCard />);
    expect(await screen.findByText(/Requests use the platform price of \$10/)).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "Use my Drive request price" }));
    fireEvent.change(screen.getByLabelText("Price in US dollars"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save request price" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledExactlyOnceWith("owner-token", {
      enabled: true, amountCents: 2500, expectedVersion: 4,
    }));
    expect(await screen.findByText(/Existing quotes stay the same/)).toBeVisible();
  });

  it("reloads a changed price instead of silently overwriting it", async () => {
    state.save.mockRejectedValueOnce(new ApiError("Price changed", 409, { detail: { code: "price_changed" } }));
    state.owner.mockResolvedValueOnce({ enabled: false, amountCents: 1000, version: 4 })
      .mockResolvedValueOnce({ enabled: true, amountCents: 3500, version: 5 });
    render(<DocumentRequestPricingCard />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Price in US dollars"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save request price" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(screen.getByLabelText("Price in US dollars")).toHaveValue("35");
  });
});
