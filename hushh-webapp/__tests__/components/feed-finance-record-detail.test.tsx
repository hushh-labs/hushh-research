import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { FeedWithRecordDetail } from "@/components/feed/feed-funding-detail";

const m = vi.hoisted(() => ({ query: "", ready: true, current: true, session: "owner:1", load: vi.fn(), history:vi.fn() }));
const capture = () => ({ userId: "owner", vaultKey: "memory-only", vaultOwnerToken: "memory-only", isCurrent: () => m.current });
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(m.query) }));
vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({ useFinanceShareContext: () => ({ capture, ready: m.ready, session: m.session }) }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { loadDomainData: m.load } }));
vi.mock("@/lib/services/kai-history-service", async original => ({
  ...await original<typeof import("@/lib/services/kai-history-service")>(), KaiHistoryService:{ getAllHistory:m.history },
}));
vi.mock("@/components/kai/views/history-detail-view", () => ({ HistoryDetailView:({entry}:any)=><p>{entry.final_statement}</p> }));
vi.mock("@/components/feed/feed-page", () => ({ FeedPage: () => <p>Mixed Feed</p> }));
vi.mock("@/components/app-ui/app-page-shell", () => ({ AppPageShell: ({ children }: any) => <main>{children}</main>, AppPageContentRegion: ({ children }: any) => children }));
beforeEach(() => { m.query=""; m.ready=true; m.current=true; m.session="owner:1"; m.load.mockReset(); m.history.mockReset(); });

it("opens the selected historical statement, never the current statement or ordinary Feed", async () => {
  m.query="statement_id=old";
  m.load.mockResolvedValue({ documents: { statements: [
    { id: "current", source: { brokerage: "Current broker" } },
    { id: "old", source: { brokerage: "Old broker", statement_period_end: "2025-01-31" } },
  ] } });
  const view = render(<FeedWithRecordDetail />);
  expect(await screen.findByRole("heading", { name: "Old broker" })).toBeVisible();
  expect(screen.getByText("2025-01-31")).toBeVisible();
  expect(screen.queryByText("Mixed Feed")).toBeNull();
  m.query="statement_id=missing";
  view.rerender(<FeedWithRecordDetail />);
  expect(await screen.findByText("Record no longer available.")).toBeVisible();
  expect(screen.queryByText("Current broker")).toBeNull();
});

it("opens the exact institution's confirmed connection state", async () => {
  m.query="institution_id=qa-item";
  m.load.mockResolvedValue({ connections_v1: { "qa-item": { institution_name: "QA bank", status: "needs_relink" } } });
  render(<FeedWithRecordDetail />);
  expect(await screen.findByRole("heading", { name: "QA bank" })).toBeVisible();
  expect(screen.getByText("Sign-in needed")).toBeVisible();
  expect(screen.getByRole("link", { name: "View sources" })).toHaveAttribute("href", "/one/kai/portfolio/sources?from=%2Fone%2Ffeed");
});

it("does not expose a late source response after the owner session changes", async () => {
  m.query="statement_id=private";
  let finish!: (value: unknown) => void;
  m.load.mockReturnValue(new Promise(resolve => { finish=resolve; }));
  const view = render(<FeedWithRecordDetail />);
  m.current=false; m.ready=false; m.session="other:2";
  view.rerender(<FeedWithRecordDetail />);
  await act(async () => finish({ documents: { statements: [{ id: "private", source: { brokerage: "Private broker" } }] } }));
  expect(screen.queryByText("Private broker")).toBeNull();
  expect(screen.getByText("Unlock your vault to view this record.")).toBeVisible();
});


it("opens the exact report independently of other running or saved analyses", async () => {
  m.query="analysis_id=run%3Arequested";
  m.history.mockResolvedValue({ AAPL:[
    {ticker:"AAPL",timestamp:"2026-11-20T12:00:00Z",raw_card:{debate_run_id:"current"},final_statement:"Other report"},
    {ticker:"AAPL",timestamp:"2026-11-19T12:00:00Z",raw_card:{debate_run_id:"requested"},final_statement:"Requested report"},
  ] });
  const view=render(<FeedWithRecordDetail />);
  expect(await screen.findByText("Requested report")).toBeVisible();
  expect(screen.queryByText("Other report")).toBeNull();
  m.query="analysis_id=run%3Aabsent";
  view.rerender(<FeedWithRecordDetail />);
  expect(await screen.findByText("Report unavailable on this device.")).toBeVisible();
  expect(screen.queryByText("Other report")).toBeNull();
});

it("fences a late decrypted report when its owner session ends", async () => {
  m.query="analysis_id=run%3Aprivate";
  let finish!:(value:unknown)=>void;
  m.history.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const view=render(<FeedWithRecordDetail />);
  m.current=false; m.ready=false; m.session="other:2";
  view.rerender(<FeedWithRecordDetail />);
  await act(async()=>finish({ AAPL:[{ticker:"AAPL",timestamp:"2026-11-19T12:00:00Z",raw_card:{debate_run_id:"private"},final_statement:"Private report"}] }));
  expect(screen.queryByText("Private report")).toBeNull();
  expect(screen.getByText("Unlock your vault to view this report.")).toBeVisible();
});
