import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DecisionCard } from "@/components/kai/views/decision-card";


const streamMocks = vi.hoisted(() => ({ listener: null as null | ((event: unknown) => void) }));
vi.mock("@/lib/services/debate-run-manager", () => ({ DebateRunManagerService: {
  ensureRun: async () => ({ kind: "started", task: { runId: "snapshot-regression", status: "running" } }),
  subscribe: () => () => {}, subscribeHistory: () => () => {},
  subscribeRunEvents: (_run: string, listener: (event: unknown) => void) => { streamMocks.listener = listener; return () => {}; },
} }));
vi.mock("@/lib/kai/market-snapshot", () => ({
  fetchLatestMarketSnapshot: async () => ({ last_price: 999, change_pct: 2, source: "newer-display-quote", observed_at: "2026-10-21T15:00:00Z" }),
  getLatestMarketSnapshotFromCache: () => ({ last_price: 999, change_pct: 2, source: "newer-display-quote", observed_at: "2026-10-21T15:00:00Z" }),
}));
vi.mock("@/lib/services/kai-service", () => ({ setKaiVaultOwnerToken: () => {} }));
import { DebateStreamView } from "@/components/kai/debate-stream-view";

describe("Finance detailed analysis", () => {
  it("keeps the analysis quote and its provenance when the display quote is newer", async () => {
    const onDecisionReady = vi.fn();
    render(<DebateStreamView ticker="TEST" userId="snapshot-owner" riskProfile="balanced" vaultKey="" vaultOwnerToken="fixture-token" onClose={() => {}} onDecisionReady={onDecisionReady} />);
    await waitFor(() => expect(streamMocks.listener).toBeTypeOf("function"));
    const snapshot = { last_price: 100, change_pct: null, observed_at: null, source: "valuation-provider", currency: "USD", quote_delay_minutes: 15, is_stale: true, stale_reason: "provider_unavailable" };
    act(() => streamMocks.listener!({ seq: 1, event: "decision", payload: { ticker: "TEST", decision: "hold", confidence: 0, raw_card: { market_snapshot: snapshot } } }));
    await waitFor(() => expect(onDecisionReady).toHaveBeenCalledOnce());
    expect(onDecisionReady.mock.calls[0][0].raw_card.market_snapshot).toEqual(snapshot);
  });

  it("shows limited analyst coverage without changing the reported decision", () => {
    render(<DecisionCard result={{
      ticker: "TEST", decision: "reduce", confidence: 0, consensus_reached: false,
      analysis_degraded: true, degraded_agents: ["valuation"], final_statement: "Limited evidence",
      raw_card: { owns_position: false },
    }} />);
    expect(screen.getByText("Limited analysis")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("valuation");
    expect(screen.getByText("Review the risks before opening a position.")).toBeVisible();
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
  });

  it("starts compact while retaining the full rationale, strategy and evidence on demand", () => {
    render(<DecisionCard result={{
      ticker: "TEST", decision: "buy", confidence: 0.82, consensus_reached: true,
      final_statement: "Full verdict retained",
      dissenting_opinions: ["Independent dissent retained"],
      raw_card: {
        fundamental_insight: { summary: "Key takeaway visible", business_moat: "Moat retained" },
        llm_synthesis: { thesis: "Strategy retained", action_plan: ["Action retained"] },
        structured_sources: [{ label: "Evidence source", url: "https://example.com/evidence" }],
      },
    }} />);
    expect(screen.getByText("Key takeaway visible")).toBeVisible();
    expect(screen.getByText("82%")).toBeVisible();
    expect(screen.queryByText("Full verdict retained")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rationale & fundamentals" }));
    expect(screen.getByText("Full verdict retained")).toBeVisible();
    expect(screen.getByText("Moat retained")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Strategy, risks & action plan" }));
    expect(screen.getByText("Action retained")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Debate evidence & sources" }));
    expect(screen.getByText("Independent dissent retained")).toBeVisible();
    expect(screen.getByRole("link", { name: "Evidence source" })).toHaveAttribute("href", "https://example.com/evidence");
  });
});
