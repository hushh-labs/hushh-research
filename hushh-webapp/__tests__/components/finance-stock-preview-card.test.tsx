import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceStockPreviewCard } from "@/components/agent/finance-stock-preview-card";
import type { DebateRunManagerState, DebateRunTask } from "@/lib/services/debate-run-manager";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";

const ports = vi.hoisted(() => ({
  preview: vi.fn(), prepare: vi.fn(), start: vi.fn(), resume: vi.fn(), reconnect: vi.fn(),
  state: (_state: DebateRunManagerState) => {},
  event: (_event: KaiStreamEnvelope) => {},
  subscribed: vi.fn(),
  handler: null as null | ((slots: Record<string, unknown>, context: { humanConfirmationToken: string }) => Promise<unknown>),
  isVaultUnlocked: true,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "owner" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: ports.isVaultUnlocked, vaultOwnerToken: "owner-token", vaultKey: "key" }),
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getKaiStockPreview: ports.preview } }));
vi.mock("@/lib/kai/prepare-stock-debate", () => ({ prepareStockDebate: ports.prepare }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: vi.fn() }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  useLocalOnboardingActionHandler: (_id: string, handler: typeof ports.handler, options: { enabled: boolean }) => {
    ports.handler = options.enabled ? handler : null;
  },
}));
vi.mock("@/components/kai/cards/stock-comparison-preview", () => ({ StockComparisonPreview: () => null }));
vi.mock("@/components/kai/views/analysis-summary-view", () => ({ AnalysisSummaryView: () => null }));
vi.mock("@/lib/services/debate-run-manager", () => ({
  DebateRunManagerService: {
    ensureRun: ports.start, resumeActiveRun: ports.resume, reconnectRun: ports.reconnect,
    getResultForRun: () => null,
    subscribe: (listener: typeof ports.state) => { ports.state = listener; ports.subscribed(); return () => {}; },
    subscribeRunEvents: (_id: string, listener: typeof ports.event) => { ports.event = listener; return () => {}; },
  },
}));

const task = { runId: "run-1", userId: "owner", ticker: "NVDA", status: "running", streamState: "connected" } as DebateRunTask;
function publish(updates: Partial<DebateRunTask> = {}) {
  act(() => ports.state({ tasks: [{ ...task, ...updates }], activeRunId: task.runId, debateSessionId: "session" }));
}

function openCard() {
  const details = screen.getByText("NVDA stock analysis").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
const confirmThroughGateway = async (confirmation: string) => {
  await ports.handler?.({}, { humanConfirmationToken: confirmation });
};

beforeEach(() => {
  vi.resetAllMocks();
  ports.isVaultUnlocked = true;
  ports.preview.mockResolvedValue({ symbol: "NVDA", active_pick_source: "reviewed-source" });
  ports.prepare.mockResolvedValue({ context: null, effectiveRiskProfile: "balanced" });
  ports.start.mockResolvedValue({ kind: "started", task });
});

describe("Finance stock analysis in chat", () => {
  it("refuses a gateway invocation without this card's confirmation", async () => {
    render(<FinanceStockPreviewCard ticker="NVDA" allowStart onConfirm={confirmThroughGateway} />);
    openCard();
    const start = await screen.findByRole("button", { name: "Confirm and start debate" });
    await waitFor(() => expect(start).toBeEnabled());
    const result = await ports.handler?.({}, { humanConfirmationToken: "model-supplied" });
    expect(result).toMatchObject({ status: "blocked" });
    expect(ports.start).not.toHaveBeenCalled();
  });

  it("starts only after confirmation, reconnects that exact run, then keeps the result visible if saving fails", async () => {
    render(<FinanceStockPreviewCard ticker="NVDA" allowStart onConfirm={confirmThroughGateway} />);
    openCard();
    const start = await screen.findByRole("button", { name: "Confirm and start debate" });
    await waitFor(() => expect(start).toBeEnabled());
    expect(ports.start).not.toHaveBeenCalled();
    fireEvent.click(start);
    fireEvent.click(start);
    await screen.findByText("Loading debate…");
    await waitFor(() => expect(ports.subscribed).toHaveBeenCalled());
    expect(ports.start).toHaveBeenCalledTimes(1);
    expect(ports.start).toHaveBeenCalledWith(expect.objectContaining({
      ticker: "NVDA", pickSource: "reviewed-source", userId: "owner",
    }));
    publish();
    act(() => ports.event({ event: "agent_complete" } as KaiStreamEnvelope));
    expect(screen.getByText("A research specialist finished.")).toBeVisible();
    publish({ streamState: "paused" });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(ports.reconnect).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", userId: "owner" }));
    publish({ status: "completed", persistenceState: "failed",
      finalDecision: { decision: "hold", confidence: 0.8, finalStatement: "Synthetic decision" } });
    expect(screen.getByText("Synthetic decision")).toBeVisible();
    expect(screen.getByText("The result is ready. It could not be saved to Finance history.")).toBeVisible();
    expect(ports.start).toHaveBeenCalledTimes(1);
  });

  it("restores the preview as a receipt without fetching or exposing controls", () => {
    render(<FinanceStockPreviewCard ticker="NVDA" />);
    expect(screen.getByText("NVDA stock analysis preview")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(ports.preview).not.toHaveBeenCalled();
    expect(ports.resume).not.toHaveBeenCalled();
    expect(ports.start).not.toHaveBeenCalled();
  });

  it("revokes a pending confirmation when the vault locks during preparation", async () => {
    let complete!: (value: unknown) => void;
    ports.prepare.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const view = render(<FinanceStockPreviewCard ticker="NVDA" allowStart onConfirm={confirmThroughGateway} />);
    openCard();
    const start = await screen.findByRole("button", { name: "Confirm and start debate" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    ports.isVaultUnlocked = false;
    view.rerender(<FinanceStockPreviewCard ticker="NVDA" allowStart onConfirm={confirmThroughGateway} />);
    await act(async () => complete({ context: null, effectiveRiskProfile: "balanced" }));
    expect(screen.getByText("Sign in and unlock your vault to view the analysis.")).toBeVisible();
    expect(ports.start).not.toHaveBeenCalled();
  });

  it("keeps the started run visible if the card becomes historical during dispatch", async () => {
    let finish!: (value: unknown) => void;
    ports.start.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = render(<FinanceStockPreviewCard ticker="NVDA" allowStart onConfirm={confirmThroughGateway} />);
    openCard();
    const start = await screen.findByRole("button", { name: "Confirm and start debate" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(ports.start).toHaveBeenCalledTimes(1));
    view.rerender(<FinanceStockPreviewCard ticker="NVDA" allowStart={false} />);
    await act(async () => finish({ kind: "started", task }));
    openCard();
    await waitFor(() => expect(ports.subscribed).toHaveBeenCalled());
    publish();
    expect(screen.getByText("Starting research…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm and start debate" })).toBeNull();
  });

  it("selects a completed run for a follow-up only on explicit click", async () => {
    const selected = vi.fn();
    render(<FinanceStockPreviewCard ticker="NVDA" allowStart onSelectResult={selected} onConfirm={confirmThroughGateway} />);
    openCard();
    const start = await screen.findByRole("button", { name: "Confirm and start debate" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(ports.subscribed).toHaveBeenCalled());
    publish({ status: "completed", persistenceState: "saved",
      finalDecision: { decision: "hold", confidence: 0.8, finalStatement: "Synthetic decision" } });
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ask One about this analysis" }));
    expect(selected).toHaveBeenCalledWith("run-1");
  });
});
