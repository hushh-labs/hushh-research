import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPuppyDirectModels: vi.fn(),
  getPuppyModelSelection: vi.fn(),
  setPuppyGlobalModel: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({ ApiService: api }));

import { PuppyRemoteModelPicker } from "@/components/agent/puppy-remote-model-picker";
import { PUPPY_CATALOG_TIMEOUT_MS, PUPPY_READINESS_TIMEOUT_MS, resetPuppyCatalogMemory, usePuppyCatalog, type PuppyCatalog } from "@/lib/agent/use-puppy-catalog";

beforeEach(() => {
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-1");
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
  const owner = { hushhId: "owner-1", deviceId: "device-1", vaultOwnerToken: "owner-capability" };

  it("does not send a model change after its owner retires during the version read", async () => {
    const view = renderHook(() => usePuppyCatalog(owner));
    await act(async () => { await view.result.current.load(); });
    api.getPuppyModelSelection.mockClear();
    let release!: (value: { version: number }) => void;
    api.getPuppyModelSelection.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current.applyGlobal("local/other", vi.fn());
      void view.result.current.applyGlobal("local/default", vi.fn());
    });
    expect(api.getPuppyModelSelection).toHaveBeenCalledOnce();
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner-1");
    await act(async () => { release({ version: 1 }); await pending; });
    expect(api.setPuppyGlobalModel).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not publish a retired owner's final model refresh", async () => {
    vi.useFakeTimers();
    const view = renderHook(() => usePuppyCatalog(owner));
    try {
      await act(async () => { await view.result.current.load(); });
      api.setPuppyGlobalModel.mockResolvedValueOnce({ id: "operation" });
      api.getPuppyModelSelection.mockResolvedValue({ status: "applied", version: 2, id: "operation" });
      let release!: (value: PuppyCatalog) => void;
      api.getPuppyDirectModels.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
      const applied = vi.fn();
      let pending!: Promise<void>;
      await act(async () => { pending = view.result.current.applyGlobal("local/other", applied); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(api.setPuppyGlobalModel).toHaveBeenCalledTimes(1);
      publishValidatedAuthSessionOwner("owner-2");
      await act(async () => {
        release({ status: "available", defaultModel: "local/other", models: [{ id: "local/other" }], catalogVersion: "new", observedAt: null, receivedAt: null });
        await pending;
      });
      expect(applied).not.toHaveBeenCalled();
      view.rerender();
      expect(view.result.current.catalog).toBeNull();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("coalesces visible Puppy readiness with opening the model menu, without a model change", async () => {
    let release!: (value: PuppyCatalog) => void;
    api.getPuppyDirectModels.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    render(<PuppyRemoteModelPicker {...owner} chatModel={null} busy={false} hasTurns={false}
      onChatModel={vi.fn()} onGlobalModel={vi.fn()} machineState="quiet" />);
    expect(api.getPuppyDirectModels).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
    expect(api.getPuppyDirectModels).toHaveBeenCalledTimes(1);
    await act(async () => { release({ status: "available", defaultModel: "local/default", models: [{ id: "local/default" }], catalogVersion: "one", observedAt: null, receivedAt: null }); });
    expect(await screen.findByRole("button", { name: /^local\/default/ })).toBeVisible();
    expect(api.setPuppyGlobalModel).not.toHaveBeenCalled();
  });

  it.each([false, true])("retires the model portal on loss of ownership (confirmation: %s)", async confirmation => {
    const props = { hushhId: "owner-1", deviceId: "device-1", vaultOwnerToken: "owner-capability",
      chatModel: null, busy: false, hasTurns: false, onChatModel: vi.fn(), onGlobalModel: vi.fn() };
    const view = render(<PuppyRemoteModelPicker {...props} active />);
    fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
    const option = await screen.findByRole("button", { name: "local/other" });
    if (confirmation) {
      fireEvent.click(option);
      await screen.findByRole("heading", { name: "Use local/other?" });
    }
    view.rerender(<PuppyRemoteModelPicker {...props} active={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(<PuppyRemoteModelPicker {...props} active />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.onChatModel).not.toHaveBeenCalled();
    expect(props.onGlobalModel).not.toHaveBeenCalled();
  });

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
  it("keeps cached models usable while readiness continues, then bounds an unanswered connection", async () => {
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
      expect(screen.getByText("Waking your private agent. The model list will update here.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "local/other" })).toBeEnabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(PUPPY_READINESS_TIMEOUT_MS - PUPPY_CATALOG_TIMEOUT_MS); });
      expect(screen.getByText("Your agent is still waking up. These are the models your computer had last time.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "local/other" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers a healthy 15-second activation without requiring another menu request", async () => {
    vi.useFakeTimers();
    try {
      api.getPuppyDirectModels.mockImplementation((_h: string, _d: string, _t: string, signal: AbortSignal, answered: () => void) => {
        answered();
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          setTimeout(() => resolve({ status: "available", defaultModel: "local/default", catalogVersion: "ready",
            models: [{ id: "local/default" }] }), 15_000);
        });
      });
      render(<PuppyRemoteModelPicker
        hushhId="owner-1" deviceId="device-1" vaultOwnerToken="owner-capability"
        chatModel={null} busy={false} hasTurns={false} onChatModel={vi.fn()} onGlobalModel={vi.fn()}
      />);
      fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
      expect(screen.getByText("Checking the models on your computer…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(PUPPY_CATALOG_TIMEOUT_MS); });
      expect(screen.queryByText("Checking the models on your computer…")).not.toBeInTheDocument();
      expect(screen.getByText("Connecting to your computer. The model list will update here.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      // Reopening joins the existing readiness attempt rather than posting a new activation.
      fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Choose Puppy model/ }));
      expect(api.getPuppyDirectModels).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(screen.getByRole("button", { name: /^local\/default/ })).toBeInTheDocument();
      expect(screen.queryByText(/The model list will update here/)).not.toBeInTheDocument();
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
    expect(chip).toHaveTextContent("gemma-4-12b");
    expect(screen.getByTitle("google/gemma-4-12b")).toBeInTheDocument();
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
      expect(screen.getByText("Waking your private agent. The model list will update here.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(PUPPY_READINESS_TIMEOUT_MS - PUPPY_CATALOG_TIMEOUT_MS); });
      expect(screen.getByText("Waking your agent… This can take a minute after a break.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["inactive", "hidden", "unmount"])("cancels readiness on %s and ignores a late catalog", async reason => {
    let signal!: AbortSignal;
    let release!: (value: PuppyCatalog) => void;
    api.getPuppyDirectModels.mockImplementation((_h: string, _d: string, _t: string, readSignal: AbortSignal) => {
      signal = readSignal;
      return new Promise(resolve => { release = resolve; });
    });
    const view = renderHook(({ enabled }) => usePuppyCatalog({ ...owner, enabled }), { initialProps: { enabled: true } });
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.load(); });
    let restoreVisibility: (() => void) | undefined;
    try {
      if (reason === "inactive") view.rerender({ enabled: false });
      else if (reason === "unmount") view.unmount();
      else {
        const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        restoreVisibility = () => visibility.mockRestore();
        fireEvent(document, new Event("visibilitychange"));
      }
      expect(signal.aborted).toBe(true);
      await act(async () => {
        release({ status: "available", defaultModel: "late", models: [{ id: "late" }], catalogVersion: "late", observedAt: null, receivedAt: null });
        await pending;
      });
      if (reason !== "unmount") expect(view.result.current.catalog).toBeNull();
    } finally { restoreVisibility?.(); view.unmount(); }
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
