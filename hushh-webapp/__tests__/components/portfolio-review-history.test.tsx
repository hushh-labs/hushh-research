import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PortfolioReviewView } from "@/components/kai/views/portfolio-review-view";

const saved = vi.hoisted(() => ({ domain: null as Record<string, unknown> | null, cache: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: "synthetic-memory-key", vaultOwnerToken: "synthetic-token" }) }));
vi.mock("@/lib/cache/cache-context", () => ({ useCache: () => ({ setPortfolioData: saved.cache }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/one/kai/import", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: { checkVault: async () => true } }));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ PkmDomainResourceService: { prepareDomainWriteContext: async () => ({ domainData: {} }) } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: {
  saveMergedDomain: async ({ build }: { build: () => { domainData: Record<string, unknown> } }) => {
    saved.domain = build().domainData;
    return { success: true };
  },
} }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onPortfolioUpserted: vi.fn() } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: {} }));
vi.mock("@/lib/services/app-background-task-service", () => ({ AppBackgroundTaskService: {
  startTask: () => "synthetic-save", completeTask: vi.fn(), failTask: vi.fn(),
} }));

it("retains supplied balance observations in the confirmed stored portfolio and selected snapshot", async () => {
  const history = [{ date: "2026-07-01", value: 0 }, { date: "2026-07-31", value: 120 }];
  render(<PortfolioReviewView userId="synthetic-owner" onSaveComplete={vi.fn()} onReimport={vi.fn()}
    portfolioData={{ historical_values: history, total_value: 120, account_summary: { ending_value: 120 },
      account_info: { brokerage: "Example", statement_period_end: "2026-07-31" },
      holdings: [{ symbol: "TEST", name: "Example holding", quantity: 1, price: 120, market_value: 120 }] }} />);
  fireEvent.click(screen.getByRole("button", { name: /Save.*Vault/i }));
  await waitFor(() => expect(saved.domain).not.toBeNull());
  expect(saved.domain?.portfolio).toMatchObject({ historical_values: history });
  const sources = saved.domain?.sources as { statement: { snapshots: Array<{ canonical_v2: unknown }> } };
  expect(sources.statement.snapshots[0]?.canonical_v2).toMatchObject({ historical_values: history });
  await waitFor(() => expect(saved.cache.mock.calls.at(-1)?.[1]).toMatchObject({ historical_values: history }));
});
