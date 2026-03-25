// components/kai/modals/edit-holding-modal.tsx

/**
 * Edit Holding Modal - Modal for editing individual holdings
 *
 * Features:
 * - Pre-filled form with current values
 * - Fields: symbol, name, quantity, price, cost basis, acquisition date
 * - Validation for numeric fields
 * - Save/Cancel buttons
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Calendar, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import {
  getTickerUniverseSnapshot,
  preloadTickerUniverse,
  searchTickerUniverse,
  searchTickerUniverseRemote,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

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
}

interface EditHoldingModalProps {
  isOpen: boolean;
  onClose: () => void;
  holding: Holding | null;
  onSave: (holding: Holding) => void;
}

type SuggestionField = "symbol" | "name";

function getLocalDateIso(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTickerMetadataLabel(row: TickerUniverseRow): string {
  return String(
    row.sector_primary || row.sector || row.industry_primary || row.industry || row.exchange || ""
  ).trim();
}

function scoreTickerMatch(row: TickerUniverseRow, query: string, field: SuggestionField): number {
  const qLower = query.trim().toLowerCase();
  const qUpper = query.trim().toUpperCase();
  const ticker = String(row.ticker || "").toUpperCase();
  const title = String(row.title || "").toLowerCase();

  if (!qLower) return 0;

  if (field === "symbol") {
    if (ticker.startsWith(qUpper)) return 0;
    if (ticker.includes(qUpper)) return 1;
    if (title.startsWith(qLower)) return 2;
    if (title.includes(qLower)) return 3;
    return 4;
  }

  if (title.startsWith(qLower)) return 0;
  if (title.includes(qLower)) return 1;
  if (ticker.startsWith(qUpper)) return 2;
  if (ticker.includes(qUpper)) return 3;
  return 4;
}

function buildSuggestions(
  localRows: TickerUniverseRow[],
  remoteRows: TickerUniverseRow[],
  query: string,
  field: SuggestionField,
  limit = 8
): TickerUniverseRow[] {
  const byTicker = new Map<string, TickerUniverseRow>();
  for (const row of [...localRows, ...remoteRows]) {
    const key = String(row.ticker || "").toUpperCase();
    if (!key) continue;
    if (!byTicker.has(key)) {
      byTicker.set(key, row);
    }
  }

  return Array.from(byTicker.values())
    .sort((a, b) => {
      const scoreDiff = scoreTickerMatch(a, query, field) - scoreTickerMatch(b, query, field);
      if (scoreDiff !== 0) return scoreDiff;
      return String(a.ticker || "").localeCompare(String(b.ticker || ""));
    })
    .slice(0, limit);
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function EditHoldingModal({
  isOpen,
  onClose,
  holding,
  onSave,
}: EditHoldingModalProps) {
  const maxAcquisitionDate = getLocalDateIso();
  const acquisitionDateInputRef = useRef<HTMLInputElement | null>(null);
  const symbolInputWrapRef = useRef<HTMLDivElement | null>(null);
  const nameInputWrapRef = useRef<HTMLDivElement | null>(null);
  const [formData, setFormData] = useState<Holding>({
    symbol: "",
    name: "",
    quantity: 0,
    price: 0,
    market_value: 0,
    cost_basis: 0,
    acquisition_date: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const initialUniverse = getTickerUniverseSnapshot();
  const [tickerUniverse, setTickerUniverse] = useState<TickerUniverseRow[] | null>(initialUniverse);
  const [remoteMatches, setRemoteMatches] = useState<TickerUniverseRow[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [activeSuggestionField, setActiveSuggestionField] = useState<SuggestionField | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const rows = await preloadTickerUniverse();
        if (!cancelled) {
          setTickerUniverse(rows);
        }
      } catch {
        // Keep cached snapshot only.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Initialize form data when holding changes
  useEffect(() => {
    if (holding) {
      setFormData({
        symbol: holding.symbol || "",
        name: holding.name || "",
        quantity: holding.quantity || 0,
        price: holding.price || 0,
        market_value: holding.market_value || 0,
        cost_basis: holding.cost_basis || 0,
        unrealized_gain_loss: holding.unrealized_gain_loss,
        unrealized_gain_loss_pct: holding.unrealized_gain_loss_pct,
        acquisition_date: holding.acquisition_date || "",
      });
      setErrors({});
    }
  }, [holding]);

  // Update market value when quantity or price changes
  useEffect(() => {
    const marketValue = formData.quantity * formData.price;
    const gainLoss = formData.cost_basis ? marketValue - formData.cost_basis : 0;
    const gainLossPct = formData.cost_basis && formData.cost_basis > 0 
      ? (gainLoss / formData.cost_basis) * 100 
      : 0;

    setFormData(prev => ({
      ...prev,
      market_value: marketValue,
      unrealized_gain_loss: gainLoss,
      unrealized_gain_loss_pct: gainLossPct,
    }));
  }, [formData.quantity, formData.price, formData.cost_basis]);

  useEffect(() => {
    const query =
      activeSuggestionField === "symbol"
        ? formData.symbol.trim()
        : activeSuggestionField === "name"
          ? formData.name.trim()
          : "";

    if (!activeSuggestionField || !query) {
      setRemoteMatches([]);
      setSuggestionsLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setSuggestionsLoading(true);
        const rows = await searchTickerUniverseRemote(query, 25);
        if (cancelled) return;
        setRemoteMatches(rows);
        if (rows.length > 0) {
          setTickerUniverse((prev) => {
            if (!prev || prev.length === 0) return rows;
            const byTicker = new Map(prev.map((row) => [row.ticker.toUpperCase(), row]));
            for (const row of rows) {
              const key = row.ticker.toUpperCase();
              if (!byTicker.has(key)) {
                byTicker.set(key, row);
              }
            }
            return Array.from(byTicker.values());
          });
        }
      } catch {
        if (!cancelled) setRemoteMatches([]);
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeSuggestionField, formData.name, formData.symbol]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const targetNode = event.target as Node;
      const withinSymbol = symbolInputWrapRef.current?.contains(targetNode) ?? false;
      const withinName = nameInputWrapRef.current?.contains(targetNode) ?? false;
      if (!withinSymbol && !withinName) {
        setActiveSuggestionField(null);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  // Handle input change
  const handleChange = useCallback((field: keyof Holding, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      [field]: value,
    }));
    // Clear error for this field
    setErrors(prev => {
      const newErrors = { ...prev };
      delete newErrors[field];
      if (field === "quantity" || field === "price") {
        delete newErrors.market_value;
      }
      return newErrors;
    });
  }, []);

  const activeQuery =
    activeSuggestionField === "symbol"
      ? formData.symbol.trim()
      : activeSuggestionField === "name"
        ? formData.name.trim()
        : "";

  const localSuggestionMatches = (() => {
    if (!tickerUniverse || !activeQuery || !activeSuggestionField) return [] as TickerUniverseRow[];
    return searchTickerUniverse(tickerUniverse, activeQuery, 25);
  })();

  const activeSuggestions = activeSuggestionField
    ? buildSuggestions(localSuggestionMatches, remoteMatches, activeQuery, activeSuggestionField, 8)
    : [];

  const applySuggestion = useCallback((row: TickerUniverseRow) => {
    const symbol = String(row.ticker || "").toUpperCase();
    const name = String(row.title || "").trim();

    setFormData((prev) => ({
      ...prev,
      symbol: symbol || prev.symbol,
      name: name || prev.name,
    }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.symbol;
      delete next.name;
      return next;
    });
    setActiveSuggestionField(null);
  }, []);

  // Validate form
  const validate = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.symbol.trim()) {
      newErrors.symbol = "Symbol is required";
    } else if (!/^[A-Z0-9]{1,5}(?:[.-][A-Z0-9]{1,3})?$/.test(formData.symbol.toUpperCase())) {
      newErrors.symbol = "Invalid symbol format";
    }

    if (!formData.name.trim()) {
      newErrors.name = "Name is required";
    }

    const quantity = Number(formData.quantity);
    const price = Number(formData.price);
    const marketValue = quantity * price;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      newErrors.quantity = "Quantity must be greater than 0";
    }

    if (!Number.isFinite(price) || price <= 0) {
      newErrors.price = "Price must be greater than 0";
    }

    if (!Number.isFinite(marketValue) || marketValue <= 0) {
      newErrors.market_value = "Market value must be greater than $0.00";
    }

    if (formData.cost_basis !== undefined && Number(formData.cost_basis) < 0) {
      newErrors.cost_basis = "Cost basis cannot be negative";
    }

    const acquisitionDate = String(formData.acquisition_date || "").trim();
    if (acquisitionDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(acquisitionDate)) {
        newErrors.acquisition_date = "Enter a valid date";
      } else if (acquisitionDate > maxAcquisitionDate) {
        newErrors.acquisition_date = "Acquisition date cannot be in the future";
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData, maxAcquisitionDate]);

  // Handle save
  const handleSave = useCallback(() => {
    if (!validate()) return;

    onSave({
      ...formData,
      symbol: formData.symbol.toUpperCase(),
    });
  }, [formData, validate, onSave]);

  const handleOpenDatePicker = useCallback(() => {
    const input = acquisitionDateInputRef.current;
    if (!input) return;

    // showPicker is supported in modern Chromium; click/focus fallback keeps Safari/iOS usable.
    try {
      (input as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
      return;
    } catch {
      // no-op: fallback below
    }
    input.focus({ preventScroll: true });
    input.click();
  }, []);

  const formatAcquisitionDate = useCallback((value?: string) => {
    if (!value) return "";
    const [year, month, day] = value.split("-");
    if (!year || !month || !day) return value;
    return `${month}/${day}/${year}`;
  }, []);

  const isNewHolding = !holding?.symbol;

  return (
    <Drawer open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>
            {isNewHolding ? "Add Holding" : "Edit Holding"}
          </DrawerTitle>
          <DrawerDescription>
            Update your portfolio details securely. All changes are encrypted.
          </DrawerDescription>
        </DrawerHeader>

        <div className="px-4 py-2 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Symbol */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Symbol <span className="text-red-500">*</span>
            </label>
            <div ref={symbolInputWrapRef} className="relative">
              <input
                type="text"
                value={formData.symbol}
                onChange={(e) => handleChange("symbol", e.target.value.toUpperCase())}
                onFocus={() => setActiveSuggestionField("symbol")}
                onBlur={() =>
                  window.setTimeout(() => {
                    setActiveSuggestionField((prev) => (prev === "symbol" ? null : prev));
                  }, 120)
                }
                placeholder="e.g., AAPL"
                maxLength={12}
                autoComplete="off"
                className={cn(
                  "w-full px-3 py-2 rounded-lg border bg-background outline-none transition-colors",
                  errors.symbol
                    ? "border-red-500 focus:border-red-500"
                    : "border-border focus:border-primary"
                )}
              />

              {activeSuggestionField === "symbol" && activeQuery && (
                <div className="absolute z-40 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-background shadow-lg">
                  {activeSuggestions.map((row) => {
                    const metadata = getTickerMetadataLabel(row);
                    return (
                      <button
                        key={`symbol-suggestion-${row.ticker}`}
                        type="button"
                        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applySuggestion(row)}
                      >
                        <span className="min-w-[72px] font-semibold">{String(row.ticker || "").toUpperCase()}</span>
                        <span className="truncate text-muted-foreground">
                          {row.title || "Unknown company"}
                          {metadata ? ` • ${metadata}` : ""}
                        </span>
                      </button>
                    );
                  })}
                  {activeSuggestions.length === 0 && (
                    <p className="px-3 py-2 text-sm text-muted-foreground">
                      {suggestionsLoading ? "Loading suggestions..." : "No matches found."}
                    </p>
                  )}
                </div>
              )}
            </div>
            {errors.symbol && (
              <p className="text-sm text-red-500 mt-1">{errors.symbol}</p>
            )}
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Company Name <span className="text-red-500">*</span>
            </label>
            <div ref={nameInputWrapRef} className="relative">
              <input
                type="text"
                value={formData.name}
                onChange={(e) => handleChange("name", e.target.value)}
                onFocus={() => setActiveSuggestionField("name")}
                onBlur={() =>
                  window.setTimeout(() => {
                    setActiveSuggestionField((prev) => (prev === "name" ? null : prev));
                  }, 120)
                }
                placeholder="e.g., Apple Inc."
                autoComplete="off"
                className={cn(
                  "w-full px-3 py-2 rounded-lg border bg-background outline-none transition-colors",
                  errors.name
                    ? "border-red-500 focus:border-red-500"
                    : "border-border focus:border-primary"
                )}
              />

              {activeSuggestionField === "name" && activeQuery && (
                <div className="absolute z-40 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-background shadow-lg">
                  {activeSuggestions.map((row) => {
                    const metadata = getTickerMetadataLabel(row);
                    return (
                      <button
                        key={`name-suggestion-${row.ticker}`}
                        type="button"
                        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applySuggestion(row)}
                      >
                        <span className="min-w-[72px] font-semibold">{String(row.ticker || "").toUpperCase()}</span>
                        <span className="truncate text-muted-foreground">
                          {row.title || "Unknown company"}
                          {metadata ? ` • ${metadata}` : ""}
                        </span>
                      </button>
                    );
                  })}
                  {activeSuggestions.length === 0 && (
                    <p className="px-3 py-2 text-sm text-muted-foreground">
                      {suggestionsLoading ? "Loading suggestions..." : "No matches found."}
                    </p>
                  )}
                </div>
              )}
            </div>
            {errors.name && (
              <p className="text-sm text-red-500 mt-1">{errors.name}</p>
            )}
          </div>

          {/* Quantity & Price Row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">
                Quantity <span className="text-red-500">*</span>
              </label>
	              <input
                type="number"
                value={formData.quantity || ""}
                onChange={(e) => handleChange("quantity", parseFloat(e.target.value) || 0)}
                placeholder="0"
                min="0.0001"
                step="0.0001"
                className={cn(
                  "w-full px-4 py-3 h-12 rounded-xl border bg-background outline-none transition-colors",
                  errors.quantity
                    ? "border-red-500 focus:border-red-500"
                    : "border-border focus:border-primary"
                )}
              />
              {errors.quantity && (
                <p className="text-sm text-red-500 mt-1">{errors.quantity}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Price <span className="text-red-500">*</span>
              </label>
	              <input
                type="number"
                value={formData.price || ""}
                onChange={(e) => handleChange("price", parseFloat(e.target.value) || 0)}
                placeholder="0.00"
                min="0.01"
                step="0.01"
                className={cn(
                  "w-full px-4 py-3 h-12 rounded-xl border bg-background outline-none transition-colors",
                  errors.price
                    ? "border-red-500 focus:border-red-500"
                    : "border-border focus:border-primary"
                )}
              />
              {errors.price && (
                <p className="text-sm text-red-500 mt-1">{errors.price}</p>
              )}
            </div>
          </div>

          {/* Market Value (calculated, read-only) */}
          <div>
            <label className="block text-sm text-muted-foreground font-medium mb-1">
              Market Value (Auto-calculated)
            </label>
            <input
              type="text"
              value={`$${formData.market_value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              readOnly
              className={cn(
                "w-full px-4 py-3 h-12 rounded-xl border bg-muted/50 text-muted-foreground font-medium",
                errors.market_value ? "border-red-500" : "border-border"
              )}
            />
            {errors.market_value && (
              <p className="text-sm text-red-500 mt-1">{errors.market_value}</p>
            )}
          </div>

          {/* Cost Basis */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Cost Basis (Total)
            </label>
            <input
              type="number"
              value={formData.cost_basis || ""}
              onChange={(e) => handleChange("cost_basis", parseFloat(e.target.value) || 0)}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="w-full px-4 py-3 h-12 rounded-xl border border-border bg-background outline-none focus:border-primary transition-colors"
            />
            {errors.cost_basis && (
              <p className="text-sm text-red-500 mt-1">{errors.cost_basis}</p>
            )}
          </div>

          {/* Acquisition Date */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Acquisition Date
            </label>
            <div className="relative">
              <input
                type="text"
                value={formatAcquisitionDate(formData.acquisition_date)}
                placeholder="MM/DD/YYYY"
                readOnly
                onClick={handleOpenDatePicker}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleOpenDatePicker();
                  }
                }}
                className="w-full px-4 py-3 pr-12 h-12 rounded-xl border border-border bg-background outline-none focus:border-primary transition-colors cursor-pointer"
              />
              <button
                type="button"
                onClick={handleOpenDatePicker}
                aria-label="Open acquisition date picker"
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              >
                <Calendar className="h-4 w-4" />
              </button>
              <input
                ref={acquisitionDateInputRef}
                type="date"
                value={formData.acquisition_date || ""}
                onChange={(e) => handleChange("acquisition_date", e.target.value)}
                max={maxAcquisitionDate}
                tabIndex={-1}
                aria-hidden="true"
                className="absolute h-px w-px opacity-0 pointer-events-none"
              />
            </div>
            {errors.acquisition_date && (
              <p className="text-sm text-red-500 mt-1">{errors.acquisition_date}</p>
            )}
          </div>

          {/* Gain/Loss Preview */}
          {formData.cost_basis !== undefined && formData.cost_basis > 0 && (
            <div className="p-4 rounded-2xl bg-muted/30 border border-border/50">
              <p className="text-sm text-muted-foreground font-medium">Unrealized Gain/Loss</p>
              <p
                className={cn(
                  "text-xl font-bold mt-1",
                  (formData.unrealized_gain_loss || 0) >= 0
                    ? "text-emerald-500"
                    : "text-red-500"
                )}
              >
                ${(formData.unrealized_gain_loss || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                {" "}
                <span className="text-sm font-medium opacity-80">
                  ({(formData.unrealized_gain_loss_pct || 0) >= 0 ? "+" : ""}
                  {(formData.unrealized_gain_loss_pct || 0).toFixed(2)}%)
                </span>
              </p>
            </div>
          )}
        </div>
 
        <DrawerFooter className="border-t bg-background/80 backdrop-blur-lg pb-[calc(5rem+var(--app-safe-area-bottom-effective))]">
          <div className="flex gap-3 w-full">
            <DrawerClose asChild>
              <Button
                variant="none"
                effect="glass"
                className="flex-1 h-12 border"
              >
                Cancel
              </Button>
            </DrawerClose>
            <Button
              onClick={handleSave}
              className="flex-1 h-12"
              icon={{ icon: Save, gradient: false }}
            >
              {isNewHolding ? "Add" : "Save Changes"}
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
