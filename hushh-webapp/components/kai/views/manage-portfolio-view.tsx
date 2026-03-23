// components/kai/views/manage-portfolio-view.tsx

/**
 * Manage Portfolio Page - Full holdings editor
 *
 * Features:
 * - Account info header
 * - Summary section (beginning/ending value, cash, equities)
 * - Scrollable holdings list with edit buttons
 * - Add Holding button
 * - Save Changes button with encryption and PKM storage
 */

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Save, Loader2, Undo2 } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";

import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Button } from "@/lib/morphy-ux/button";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { useVault } from "@/lib/vault/vault-context";
import { useAuth } from "@/lib/firebase";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";
import { useCache, type PortfolioData as CachedPortfolioData } from "@/lib/cache/cache-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { EditHoldingModal } from "@/components/kai/modals/edit-holding-modal";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";

// =============================================================================
// TYPES
// =============================================================================

interface Holding {
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  market_value: number;
  cost_basis?: number;
  unrealized_gain_loss?: number;
  unrealized_gain_loss_pct?: number;
  acquisition_date?: string;
  pending_delete?: boolean;
}

interface AccountInfo {
  account_number?: string;
  brokerage_name?: string;
  statement_period?: string;
}

interface AccountSummary {
  beginning_value?: number;
  ending_value: number;
  change_in_value?: number;
  cash_balance?: number;
  equities_value?: number;
}

interface PortfolioData {
  account_info?: AccountInfo;
  account_summary?: AccountSummary;
  holdings?: Holding[];
  transactions?: unknown[];
  domain_intent?: {
    primary?: string;
    source?: string;
    captured_sections?: string[];
    updated_at?: string;
  };
  updated_at?: string;
}

function hasValidFinancialShape(value: unknown): value is PortfolioData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const holdings = record.holdings;
  return Array.isArray(holdings);
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function _formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function deriveRiskBucket(holdings: Holding[]): string {
  if (!holdings || holdings.length === 0) return "unknown";
  
  // Simple risk calculation based on concentration
  const totalValue = holdings.reduce((sum, h) => sum + (h.market_value || 0), 0);
  if (totalValue === 0) return "unknown";
  
  const topHoldingPct = holdings.length > 0 
    ? ((holdings[0]?.market_value || 0) / totalValue) * 100 
    : 0;
  
  if (topHoldingPct > 30) return "aggressive";
  if (topHoldingPct > 15) return "moderate";
  return "conservative";
}

const SpinningLoader = (props: any) => (
  <Loader2 {...props} className={cn(props.className, "animate-spin")} />
);

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function ManagePortfolioView() {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const { getPortfolioData, setPortfolioData: setCachePortfolioData } = useCache();
  
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [accountInfo, setAccountInfo] = useState<AccountInfo>({});
  const [accountSummary, setAccountSummary] = useState<AccountSummary>({ ending_value: 0 });
  const [hasChanges, setHasChanges] = useState(false);
  
  // Edit modal state
  const [editingHolding, setEditingHolding] = useState<Holding | null>(null);
  const [editingIndex, setEditingIndex] = useState<number>(-1);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { registerSteps, completeStep, reset } = useStepProgress();
  const setBusyOperation = useKaiSession((s) => s.setBusyOperation);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;
  const activeHoldings = useMemo(
    () => holdings.filter((holding) => !holding.pending_delete),
    [holdings]
  );
  const pendingDeleteCount = holdings.length - activeHoldings.length;

  // Register 2 steps: Auth check, Load holdings
  useEffect(() => {
    registerSteps(2);
    return () => reset();
  }, [registerSteps, reset]);

  useEffect(() => {
    setBusyOperation("portfolio_manage_active", true);
    return () => {
      setBusyOperation("portfolio_manage_active", false);
    };
  }, [setBusyOperation]);

  // Load portfolio data on mount
  useEffect(() => {
    async function loadPortfolio() {
      // Step 1: Auth check
      completeStep();

      if (!user?.uid || !vaultKey) {
        setIsLoading(false);
        completeStep(); // Complete step 2 even if no data
        return;
      }

      try {
        // Fast path: if dashboard already hydrated session cache, skip metadata/blob fetch.
        const cachedPortfolio = getPortfolioData(user.uid);
        if (cachedPortfolio && Array.isArray(cachedPortfolio.holdings) && cachedPortfolio.holdings.length > 0) {
          setPortfolioData(cachedPortfolio);
          setHoldings(
            (cachedPortfolio.holdings || []).map((holding) => ({
              ...holding,
              pending_delete: Boolean((holding as Holding & { pending_delete?: boolean }).pending_delete),
            }))
          );
          setAccountInfo(cachedPortfolio.account_info || {});
          setAccountSummary(cachedPortfolio.account_summary || { ending_value: 0 });
          completeStep();
          return;
        }

        // Get PKM metadata first so we only decrypt the financial domain when needed.
        const response = await PersonalKnowledgeModelService.getMetadata(
          user.uid,
          false,
          vaultOwnerToken || undefined
        );
        const financialDomain = response.domains.find(d => d.key === "financial");
        
        if (financialDomain && financialDomain.attributeCount > 0) {
          // Priority 1: CacheProvider (shared with dashboard)
          let parsed: PortfolioData | null = getPortfolioData(user.uid);
          
          // Priority 2: Decrypt the financial PKM domain (fallback)
          if (!parsed) {
            console.log("[ManagePortfolio] No cache, attempting to decrypt the financial PKM domain...");
            try {
              const rawFinancial = await PersonalKnowledgeModelService.loadDomainData({
                userId: user.uid,
                domain: "financial",
                vaultKey,
                vaultOwnerToken: vaultOwnerToken || undefined,
              });

              if (!hasValidFinancialShape(rawFinancial)) {
                toast.error("Portfolio index exists but financial data is missing. Please re-import your statement.");
              } else {
                // Normalize Review-format → Dashboard-format field names
                parsed = normalizeStoredPortfolio(rawFinancial) as unknown as PortfolioData;

                // Update cache for future use
                setCachePortfolioData(user.uid, parsed);
                console.log("[ManagePortfolio] Decrypted and cached portfolio data");
              }
            } catch (decryptError) {
              console.error("[ManagePortfolio] Failed to decrypt the financial PKM domain:", decryptError);
              toast.error("Unable to decrypt portfolio data. Please re-import your statement.");
            }
          }
          
          if (parsed) {
            // Normalize holdings to ensure unrealized_gain_loss_pct is computed
            if (parsed.holdings) {
              parsed.holdings = parsed.holdings.map((h: Holding) => {
                if (h.unrealized_gain_loss_pct !== undefined && h.unrealized_gain_loss_pct !== 0) {
                  return h;
                }
                const unrealized = h.unrealized_gain_loss;
                if (unrealized !== undefined) {
                  let basis: number | undefined;
                  const costBasis = h.cost_basis;
                  const marketValue = h.market_value || 0;
                  if (costBasis !== undefined && Math.abs(costBasis) > 1e-6) {
                    basis = costBasis;
                  } else if (marketValue !== 0) {
                    basis = marketValue - unrealized;
                  }
                  if (basis !== undefined && Math.abs(basis) > 1e-6) {
                    return { ...h, unrealized_gain_loss_pct: (unrealized / basis) * 100 };
                  }
                }
                return h;
              });
            }
            
            setPortfolioData(parsed);
            setHoldings(
              (parsed.holdings || []).map((holding) => ({
                ...holding,
                pending_delete: Boolean(holding.pending_delete),
              }))
            );
            setAccountInfo(parsed.account_info || {});
            setAccountSummary(parsed.account_summary || { ending_value: 0 });
          }
        }
        
        // Step 2: Holdings loaded
        completeStep();
      } catch (error) {
        console.error("[ManagePortfolio] Error loading portfolio:", error);
        toast.error("Failed to load portfolio data");
        completeStep(); // Complete step 2 on error
      } finally {
        setIsLoading(false);
      }
    }

    loadPortfolio();
  }, [
    user?.uid,
    vaultKey,
    vaultOwnerToken,
    completeStep,
    getPortfolioData,
    setCachePortfolioData,
  ]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!user?.uid || !vaultKey) {
      toast.error("Please unlock your vault first");
      return;
    }

    setIsSaving(true);
    try {
      // 1. Build complete portfolio data object
      const holdingsForSave = activeHoldings.map(({ pending_delete: _pending_delete, ...rest }) => rest);
      const updatedPortfolioData: PortfolioData = {
        account_info: accountInfo,
        account_summary: {
          ...accountSummary,
          ending_value:
            holdingsForSave.reduce((sum, h) => sum + (h.market_value || 0), 0) +
            (accountSummary.cash_balance || 0),
          equities_value: holdingsForSave.reduce((sum, h) => sum + (h.market_value || 0), 0),
        },
        holdings: holdingsForSave,
        transactions: portfolioData?.transactions || [],
        domain_intent: {
          primary: "financial",
          source: "kai_manage_edit",
          captured_sections: ["account_info", "account_summary", "holdings", "transactions"],
          updated_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      };

      const nowIso = new Date().toISOString();
      const existingFinancial =
        (await PersonalKnowledgeModelService.loadDomainData({
          userId: user.uid,
          domain: "financial",
          vaultKey,
          vaultOwnerToken: vaultOwnerToken || undefined,
        }).catch(() => null)) ?? {};

      const nextFinancialDomain = {
        ...existingFinancial,
        // Compatibility mirror for readers still using direct financial fields.
        ...updatedPortfolioData,
        schema_version: 3,
        domain_intent: {
          primary: "financial",
          source: "domain_registry_prepopulate",
          contract_version: 1,
          updated_at: nowIso,
        },
        portfolio: {
          ...updatedPortfolioData,
          domain_intent: {
            primary: "financial",
            secondary: "portfolio",
            source: "kai_manage_edit",
            captured_sections: ["account_info", "account_summary", "holdings", "transactions"],
            updated_at: nowIso,
          },
        },
        updated_at: nowIso,
      };

      // 2. Store via prepared-blob path to avoid a second load/decrypt cycle.
      const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
        userId: user.uid,
        vaultKey,
        domain: "financial",
        domainData: nextFinancialDomain as unknown as Record<string, unknown>,
        summary: {
          intent_source: "kai_manage_edit",
          has_portfolio: true,
          holdings_count: holdingsForSave.length,
          total_value: updatedPortfolioData.account_summary?.ending_value || 0,
          portfolio_risk_bucket: deriveRiskBucket(holdingsForSave),
          risk_bucket: deriveRiskBucket(holdingsForSave),
          domain_contract_version: 1,
          intent_map: [
            "portfolio",
            "profile",
            "documents",
            "analysis_history",
            "runtime",
            "analysis.decisions",
          ],
          last_updated: nowIso,
        },
        baseFullBlob: { financial: existingFinancial },
        cacheFullBlob: false,
        vaultOwnerToken: vaultOwnerToken || undefined,
      });

      if (result.success) {
        setCachePortfolioData(user.uid, updatedPortfolioData);
        CacheSyncService.onPortfolioUpserted(
          user.uid,
          updatedPortfolioData as unknown as CachedPortfolioData
        );

        toast.success("Portfolio saved securely");
        setHasChanges(false);
        router.push(ROUTES.KAI_DASHBOARD);
      } else {
        throw new Error("Failed to save portfolio");
      }
    } catch (error) {
      console.error("[ManagePortfolio] Save error:", error);
      toast.error("Failed to save portfolio");
    } finally {
      setIsSaving(false);
    }
  }, [
    user?.uid,
    vaultKey,
    vaultOwnerToken,
    accountInfo,
    accountSummary,
    activeHoldings,
    portfolioData,
    router,
    setCachePortfolioData,
  ]);

  // Handle edit holding
  const handleEditHolding = useCallback((index: number) => {
    setEditingHolding(holdings[index] || null);
    setEditingIndex(index);
    setIsModalOpen(true);
  }, [holdings]);

  // Handle save holding from modal
  const handleSaveHolding = useCallback((updatedHolding: Holding) => {
    setHoldings(prev => {
      const newHoldings = [...prev];
      if (editingIndex >= 0 && editingIndex < newHoldings.length) {
        newHoldings[editingIndex] = updatedHolding;
      } else {
        // Adding new holding
        newHoldings.push(updatedHolding);
      }
      return newHoldings;
    });
    setHasChanges(true);
    setIsModalOpen(false);
    setEditingHolding(null);
    setEditingIndex(-1);
  }, [editingIndex]);

  // Handle delete holding
  const handleDeleteHolding = useCallback((index: number) => {
    setHoldings(prev =>
      prev.map((holding, i) =>
        i === index ? { ...holding, pending_delete: !holding.pending_delete } : holding
      )
    );
    setHasChanges(true);
  }, []);

  // Handle add new holding
  const handleAddHolding = useCallback(() => {
    setEditingHolding({
      symbol: "",
      name: "",
      quantity: 0,
      price: 0,
      market_value: 0,
      pending_delete: false,
    });
    setEditingIndex(-1);
    setIsModalOpen(true);
  }, []);

  // Loading state
  if (isLoading) {
    return null;
  }

  return (
    <div className="w-full">
      <div className="p-4 space-y-4">
        {/* Account Info */}
        {(accountInfo.account_number || accountInfo.brokerage_name) && (
          <Card variant="muted" effect="glass" showRipple={false}>
            <CardContent className="p-4">
              <p className="font-medium">
                Account: {accountInfo.account_number || "N/A"}
              </p>
              <p className="text-sm text-muted-foreground">
                {accountInfo.brokerage_name || "Unknown Brokerage"}
              </p>
              {accountInfo.statement_period && (
                <p className="text-sm text-muted-foreground">
                  Period: {accountInfo.statement_period}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Summary Section */}
        <Card variant="none" effect="glass" showRipple={false}>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 gap-4">
              {accountSummary.beginning_value !== undefined && (
                <div>
                  <p className="text-sm text-muted-foreground">Beginning</p>
                  <p className="font-semibold">
                    {formatCurrency(accountSummary.beginning_value)}
                  </p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">Ending</p>
                <p className="font-semibold">
                  {formatCurrency(
                    activeHoldings.reduce((sum, h) => sum + (h.market_value || 0), 0) +
                    (accountSummary.cash_balance || 0)
                  )}
                </p>
              </div>
              {accountSummary.cash_balance !== undefined && (
                <div>
                  <p className="text-sm text-muted-foreground">Cash</p>
                  <p className="font-semibold">
                    {formatCurrency(accountSummary.cash_balance)}
                  </p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">Equities</p>
                <p className="font-semibold">
                  {formatCurrency(
                    activeHoldings.reduce((sum, h) => sum + (h.market_value || 0), 0)
                  )}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Holdings Section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              Holdings ({activeHoldings.length})
              {pendingDeleteCount > 0 ? (
                <span className="ml-2 text-xs font-medium text-muted-foreground">
                  {pendingDeleteCount} pending remove
                </span>
              ) : null}
            </h2>
            <Button
              variant="none"
              effect="glass"
              size="sm"
              onClick={handleAddHolding}
              icon={{ icon: Plus, gradient: false }}
            >
              Add
            </Button>
          </div>

          <div className="space-y-3">
            {holdings.length > 0 ? (
              <>
                {holdings
                  .slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
                  .map((holding, index) => {
                    const actualIndex = (currentPage - 1) * itemsPerPage + index;
                    const gainLoss = holding.unrealized_gain_loss || 0;
                    const isPositive = gainLoss >= 0;

                    return (
                      <Card
                        key={`${holding.symbol}-${actualIndex}`}
                        variant="none"
                        effect="glass"
                        showRipple={false}
                        className={cn(holding.pending_delete && "opacity-60 border-dashed")}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "font-bold text-lg",
                                    holding.pending_delete && "line-through text-muted-foreground"
                                  )}
                                >
                                  {holding.symbol}
                                </span>
                                <span
                                  className={cn(
                                    "text-sm text-muted-foreground truncate",
                                    holding.pending_delete && "line-through"
                                  )}
                                >
                                  {holding.name}
                                </span>
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                {holding.quantity.toLocaleString()} @ {formatCurrency(holding.price)} = {formatCurrency(holding.market_value)}
                              </p>
                              {holding.cost_basis !== undefined && (
                                <p className="text-sm mt-1">
                                  <span className="text-muted-foreground font-medium">Cost: </span>
                                  <span className="font-semibold">{formatCurrency(holding.cost_basis)}</span>
                                  <span className="mx-2 opacity-20">|</span>
                                  <span className="text-muted-foreground font-medium">G/L: </span>
                                  <span className={cn("font-bold", isPositive ? "text-emerald-500" : "text-red-500")}>
                                    {isPositive ? "+" : ""}{formatCurrency(gainLoss)}
                                  </span>
                                  {holding.unrealized_gain_loss_pct !== undefined && (
                                    <span className="ml-1 text-xs text-muted-foreground">
                                      ({_formatPercent(holding.unrealized_gain_loss_pct)})
                                    </span>
                                  )}
                                </p>
                              )}

                            </div>
                            <div className="flex items-center gap-3 ml-4 border-l border-primary/10 pl-4">
                              <div className="flex flex-col items-center gap-1">
                                <Button
                                  variant="none"
                                  effect="glass"
                                  size="icon-sm"
                                  className={cn(
                                    "h-10 w-10 text-muted-foreground hover:text-primary transition-all duration-300 rounded-xl",
                                    holding.pending_delete && "pointer-events-none opacity-50"
                                  )}
                                  onClick={() => handleEditHolding(actualIndex)}
                                  icon={{ icon: Pencil }}
                                />
                                <Kbd className="text-[8px] px-1 h-3.5">EDIT</Kbd>
                              </div>
                              <div className="flex flex-col items-center gap-1">
                                <Button
                                  variant="none"
                                  effect="glass"
                                  size="icon-sm"
                                  className={cn(
                                    "h-10 w-10 transition-all duration-300 rounded-xl",
                                    holding.pending_delete
                                      ? "text-emerald-500 hover:text-emerald-600 hover:bg-emerald-50"
                                      : "text-red-400 hover:text-red-500 hover:bg-red-50"
                                  )}
                                  onClick={() => handleDeleteHolding(actualIndex)}
                                  icon={{ icon: holding.pending_delete ? Undo2 : Trash2 }}
                                />
                                <Kbd className="text-[8px] px-1 h-3.5">
                                  {holding.pending_delete ? "UNDO" : "DEL"}
                                </Kbd>
                              </div>
                            </div>

                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}

                {holdings.length > itemsPerPage && (
                  <div className="mt-6">
                    <Pagination>
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious 
                            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                            className={cn("cursor-pointer", currentPage === 1 && "pointer-events-none opacity-50")}
                          />
                        </PaginationItem>
                        
                        {Array.from({ length: Math.ceil(holdings.length / itemsPerPage) }).map((_, i) => (
                          <PaginationItem key={i}>
                            <PaginationLink
                              isActive={currentPage === i + 1}
                              onClick={() => setCurrentPage(i + 1)}
                              className="cursor-pointer"
                            >
                              {i + 1}
                            </PaginationLink>
                          </PaginationItem>
                        ))}

                        <PaginationItem>
                          <PaginationNext 
                            onClick={() => setCurrentPage(prev => Math.min(Math.ceil(holdings.length / itemsPerPage), prev + 1))}
                            className={cn("cursor-pointer", currentPage === Math.ceil(holdings.length / itemsPerPage) && "pointer-events-none opacity-50")}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  </div>
                )}
              </>
            ) : (
              <Card variant="muted" effect="glass" showRipple={false}>
                <CardContent className="p-8 text-center">
                  <p className="text-muted-foreground mb-4">
                    No holdings yet. Add your first holding or import a portfolio statement.
                  </p>
                  <Button onClick={handleAddHolding} icon={{ icon: Plus, gradient: false }}>
                    Add Holding
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Save Button - Floating Action Style */}
      {/* Save Button - Floating Action Style with Safe Area Support */}
      {hasChanges && (
        <div className="fixed left-0 right-0 bottom-[var(--app-bottom-inset)] px-10 sm:px-16 pb-2 z-[145] pointer-events-none">
          <div className="max-w-xs mx-auto pointer-events-auto">
            <Button
              onClick={handleSave}
              disabled={isSaving}
              variant="morphy"
              effect="fill"
              className="w-full h-12 text-sm font-black rounded-xl border-none shadow-xl"
              icon={{ 
                icon: isSaving ? SpinningLoader : Save,
                gradient: false 
              }}
              loading={isSaving}
            >
              {isSaving ? "SAVING..." : "SAVE CHANGES"}
            </Button>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      <EditHoldingModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingHolding(null);
          setEditingIndex(-1);
        }}
        holding={editingHolding}
        onSave={handleSaveHolding}
      />
    </div>
  );
}

export default ManagePortfolioView;
