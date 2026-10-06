import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPuppyDirectModels: vi.fn(),
  getPuppyModelSelection: vi.fn(),
  setPuppyGlobalModel: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({ ApiService: api }));

import { PuppyRemoteModelPicker } from "@/components/agent/puppy-remote-model-picker";
import { PUPPY_CATALOG_TIMEOUT_MS, resetPuppyCatalogMemory } from "@/lib/agent/use-puppy-catalog";

beforeEach(() => {
  resetPuppyCatalogMemory();
  api.getPuppyDirectModels.mockResolvedValue({
    status: "available",
    defaultModel: "local/default",
    catalogVersion: "catalog-1",
    models: [{ id: "local/default" }, { id: "local/other" }],
  });
  api.getPuppyModelSelection.mockResolvedValue({ status: "applied", version: 1 });
});

describe("Puppy remote model picker", () => {
  it("keeps confirmation open after the model list closes", async () => {
    const onChatModel = vi.fn();
    render(<PuppyRemoteModelPicker
      hushhId="owner-1" deviceId="device-1" vaultOwnerToken="owner-capability"
      chatModel={null} busy={false} hasTurns={false}
      onChatModel={onChatModel} onGlobalModel={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
    fireEvent.click(await screen.findByRole("button", { name: "local/other" }));
    expect(await screen.findByRole("heading", { name: "Use local/other?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use this model" }));

    await waitFor(() => expect(onChatModel).toHaveBeenCalledWith("local/other", "catalog-1"));
  });
  it("never sticks on checking: a slow machine times out to the last list it shared", async () => {
    const props = {
      hushhId: "owner-1", deviceId: "device-1", vaultOwnerToken: "owner-capability",
      chatModel: null, busy: false, hasTurns: false, onChatModel: vi.fn(), onGlobalModel: vi.fn(),
    };
    const first = render(<PuppyRemoteModelPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
    expect(await screen.findByRole("button", { name: "local/other" })).toBeInTheDocument();
    first.unmount();

    vi.useFakeTimers();
    try {
      api.getPuppyDirectModels.mockImplementation((_h: string, _d: string, _t: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
      render(<PuppyRemoteModelPicker {...props} />);
      fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
      // The remembered list shows at once while the machine is asked again.
      expect(screen.getByRole("button", { name: "local/other" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(PUPPY_CATALOG_TIMEOUT_MS); });
      expect(screen.getByText("Your agent is still waking up. These are the models your computer had last time.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "local/other" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says plainly when a machine with no remembered list does not answer", async () => {
    vi.useFakeTimers();
    try {
      api.getPuppyDirectModels.mockImplementation((_h: string, _d: string, _t: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
      render(<PuppyRemoteModelPicker
        hushhId="owner-1" deviceId="device-1" vaultOwnerToken="owner-capability"
        chatModel={null} busy={false} hasTurns={false} onChatModel={vi.fn()} onGlobalModel={vi.fn()}
      />);
      fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
      expect(screen.getByText("Checking the models on your computer…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(PUPPY_CATALOG_TIMEOUT_MS); });
      expect(screen.queryByText("Checking the models on your computer…")).not.toBeInTheDocument();
      expect(screen.getByText("Waking your agent… This can take a minute after a break.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the machine's state and last reported model on the header chip", () => {
    render(<PuppyRemoteModelPicker
      hushhId="owner-1" deviceId="device-1" vaultOwnerToken="owner-capability"
      chatModel={null} busy={false} hasTurns={false} onChatModel={vi.fn()} onGlobalModel={vi.fn()}
      machineState="quiet" machine="your Mac" lastKnownModel="google/gemma-4-12b"
    />);
    const chip = screen.getByTestId("puppy-header-chip");
    expect(chip).toHaveTextContent("Your Mac");
    expect(chip).toHaveTextContent("google/gemma-4-12b");
  });

  const baseProps = {
    hushhId: "owner-1", deviceId: "device-1", vaultOwnerToken: "owner-capability",
    chatModel: null, busy: false, hasTurns: false, onChatModel: vi.fn(), onGlobalModel: vi.fn(),
  };

  it("stops checking at the deadline even when waking the agent ignores the abort", async () => {
    vi.useFakeTimers();
    try {
      // The real read waits on the agent waking, which does not take the signal yet.
      api.getPuppyDirectModels.mockImplementation(() => new Promise(() => undefined));
      render(<PuppyRemoteModelPicker {...baseProps} machine="your Mac" />);
      fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
      expect(screen.getByText("Checking the models on your Mac…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(PUPPY_CATALOG_TIMEOUT_MS); });
      expect(screen.queryByText("Checking the models on your Mac…")).not.toBeInTheDocument();
      expect(screen.getByText("Waking your agent… This can take a minute after a break.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the list and Try again without waiting on a slow model-change read", async () => {
    api.getPuppyModelSelection.mockImplementation(() => new Promise(() => undefined));
    api.getPuppyDirectModels.mockResolvedValue({
      status: "unavailable", defaultModel: "", catalogVersion: "", models: [],
    });
    render(<PuppyRemoteModelPicker {...baseProps} machine="your Mac" />);
    fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
    expect(await screen.findByText("Your Mac hasn't shared its models yet. Send a message to wake it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/Checking the models/)).not.toBeInTheDocument();
  });

  it("names the agent, not the Mac, when the agent could not be reached", async () => {
    api.getPuppyDirectModels.mockRejectedValue(new Error("POD_DIRECT_UNAVAILABLE:POD_NOT_REACHED"));
    render(<PuppyRemoteModelPicker {...baseProps} machine="your Mac" />);
    fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
    expect(await screen.findByText("Couldn't reach your private agent for the list. Try again in a moment.")).toBeInTheDocument();
  });

  it("keeps the memory grant reachable mid-answer and with no linked device", async () => {
    const footer = <p>memory grant row</p>;
    const { rerender } = render(<PuppyRemoteModelPicker {...baseProps} busy footer={footer} memoryPhrase="Provider memory: off" />);
    const chip = screen.getByRole("button", { name: "Choose Puppy model. Provider memory: off" });
    expect(chip).toBeEnabled();
    fireEvent.click(chip);
    expect(await screen.findByText("memory grant row")).toBeInTheDocument();
    // An answer is running: its model is fixed, so the list is shown but locked.
    expect(await screen.findByRole("button", { name: "local/other" })).toBeDisabled();
    expect(screen.getByText("You can switch models after this answer.")).toBeInTheDocument();

    rerender(<PuppyRemoteModelPicker {...baseProps} deviceId={null} footer={footer} memoryPhrase="Provider memory: off" />);
    expect(screen.getByRole("button", { name: /^Choose Puppy model/ })).toBeEnabled();
    expect(screen.getByText("memory grant row")).toBeInTheDocument();
  });
});
