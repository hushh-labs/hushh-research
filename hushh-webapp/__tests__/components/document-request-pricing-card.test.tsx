import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: "owner-token" as string | null, epoch: 1, owner: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token }) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/services/drive-request-pricing-service", () => ({
  DriveRequestPricingService: { owner: state.owner, save: state.save },
}));

import { DocumentRequestPricingCard } from "@/components/consent/document-request-pricing-card";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { ApiError } from "@/lib/services/api-client";

const enterPrice = (value: string) => fireEvent.change(screen.getByLabelText("Default price (USD)"), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

describe("owner Drive request price", () => {
  beforeEach(() => {
    state.token = "owner-token";
    state.epoch = 1;
    state.owner.mockReset().mockResolvedValue({ enabled: false, amountCents: 1000, version: 4 });
    state.save.mockReset().mockResolvedValue({ enabled: true, amountCents: 2500, version: 5 });
  });

  it("starts unset, validates the amount, and saves a default with state invalidation", async () => {
    const calls: string[] = [];
    const reconcile = vi.fn(() => { calls.push("reconcile"); });
    const onSaved = vi.fn(() => { calls.push("saved"); });
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, reconcile);
    try {
      render(<DocumentRequestPricingCard onSaved={onSaved} />);
      expect(await screen.findByLabelText("Default price (USD)")).toHaveValue("");
      expect(screen.getByText("Set each request's price in Feed.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(screen.queryByRole("switch")).toBeNull();
      enterPrice("0");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      enterPrice("25.50");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      enterPrice("25");
      save();
      await waitFor(() => expect(state.save).toHaveBeenCalledExactlyOnceWith("owner-token", {
        enabled: true, amountCents: 2500, expectedVersion: 4,
      }));
      expect(await screen.findByText("Default price saved.")).toBeVisible();
      expect(screen.getByText(/Trusted requests use this price automatically/)).toBeVisible();
      expect(screen.queryByText("Set each request's price in Feed.")).toBeNull();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(calls).toEqual(["reconcile", "saved"]);
    } finally {
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, reconcile);
    }
  });

  it("refreshes a changed price while keeping the draft for explicit review", async () => {
    const onSaved = vi.fn();
    state.save.mockRejectedValueOnce(new ApiError("Price changed", 409, { detail: { code: "price_changed" } }));
    state.owner.mockResolvedValueOnce({ enabled: false, amountCents: 1000, version: 4 })
      .mockResolvedValueOnce({ enabled: true, amountCents: 3500, version: 5 });
    render(<DocumentRequestPricingCard onSaved={onSaved} />);
    await screen.findByLabelText("Default price (USD)");
    enterPrice("25");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Changed elsewhere to $35");
    expect(screen.getByLabelText("Default price (USD)")).toHaveValue("25");
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    save();
    await waitFor(() => expect(state.save).toHaveBeenLastCalledWith("owner-token", {
      enabled: true, amountCents: 2500, expectedVersion: 5,
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("never reports a failed save to its host", async () => {
    const onSaved = vi.fn();
    state.save.mockRejectedValueOnce(new Error("private upstream"));
    render(<DocumentRequestPricingCard onSaved={onSaved} />);
    await screen.findByLabelText("Default price (USD)");
    enterPrice("25");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save your price. Try again.");
    expect(screen.queryByText("Default price saved.")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("turns off automatic pricing without applying an unsaved draft", async () => {
    state.owner.mockResolvedValueOnce({ enabled: true, amountCents: 2500, version: 4 });
    state.save.mockResolvedValueOnce({ enabled: false, amountCents: 2500, version: 5 });
    const onSaved = vi.fn();
    render(<DocumentRequestPricingCard onSaved={onSaved} />);
    await screen.findByLabelText("Default price (USD)");
    enterPrice("invalid");
    fireEvent.click(screen.getByRole("button", { name: "Ask each time" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledExactlyOnceWith("owner-token", {
      enabled: false, amountCents: 2500, expectedVersion: 4,
    }));
    expect(await screen.findByText("You'll set a price for each request.")).toBeVisible();
    expect(screen.getByText("Set each request's price in Feed.")).toBeVisible();
    expect(screen.queryByText(/Trusted requests use this price automatically/)).toBeNull();
    expect(screen.getByLabelText("Default price (USD)")).toHaveValue("");
    // Waiting requests still need a price, so the host must not leave this screen.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("ignores an old owner's save after the account changes", async () => {
    let finish!: (value: unknown) => void;
    state.save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reconcile = vi.fn();
    const onSaved = vi.fn();
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, reconcile);
    try {
      const view = render(<DocumentRequestPricingCard onSaved={onSaved} />);
      await screen.findByLabelText("Default price (USD)");
      enterPrice("25");
      save();
      await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
      state.token = "new-owner";
      state.epoch++;
      state.owner.mockResolvedValueOnce({ enabled: true, amountCents: 500, version: 1 });
      view.rerender(<DocumentRequestPricingCard onSaved={onSaved} />);
      await waitFor(() => expect(screen.getByLabelText("Default price (USD)")).toHaveValue("5"));
      await act(async () => { finish({ enabled: true, amountCents: 2500, version: 5 }); });
      expect(screen.getByLabelText("Default price (USD)")).toHaveValue("5");
      expect(screen.queryByText("Default price saved.")).toBeNull();
      expect(reconcile).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, reconcile);
    }
  });

  it("ignores an old owner's load and lets a failed load retry", async () => {
    let finish!: (value: unknown) => void;
    state.owner.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<DocumentRequestPricingCard />);
    state.token = "new-owner";
    state.epoch++;
    state.owner.mockRejectedValueOnce(new Error("private upstream"));
    view.rerender(<DocumentRequestPricingCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your price");
    await act(async () => { finish({ enabled: true, amountCents: 2500, version: 5 }); });
    expect(screen.queryByLabelText("Default price (USD)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Default price (USD)")).toHaveValue("");
  });
});
