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
import { Save } from "@/components/icons";
import type { Holding } from "@/components/kai/types/portfolio";
import { holdingEditorErrors, normalizeHoldingAcquisitionDate, isCashEquivalentHolding, withHoldingValues, type HoldingValidationIssue, type HoldingValidationField } from "@/lib/kai/holding-validation";
import { HoldingGainLoss } from "@/components/kai/holdings/holding-gain-loss";
import { toHoldingViewModel } from "@/components/kai/holdings/holding-view-model";
import { HoldingAcquisitionDateField } from "@/components/kai/holdings/holding-acquisition-date-field";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
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

interface EditHoldingModalProps {
  isOpen: boolean;
  onClose: () => void;
  holding: Holding | null;
  onSave: (holding: Holding) => void;
  validationIssue?: HoldingValidationIssue | null;
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
  validationIssue,
}: EditHoldingModalProps) {
  const maxAcquisitionDate = getLocalDateIso();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const formRef = useRef<HTMLDivElement | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ field: HoldingValidationField; attempt: number } | null>(null);
  const focusField = useCallback((field: HoldingValidationField) => {
    const form = formRef.current;
    const input = form?.querySelector<HTMLInputElement>(`#holding-${field.replaceAll("_", "-")}`);
    if (!form || !input) return;

    input.focus({ preventScroll: true });
    const fieldBounds = input.getBoundingClientRect();
    const formTop = form.getBoundingClientRect().top;
    if (fieldBounds.top >= formTop && fieldBounds.bottom <= formTop + form.clientHeight) return;

    form.scrollTo({
      top: form.scrollTop + fieldBounds.top - formTop - (form.clientHeight - fieldBounds.height) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, []);
  useEffect(() => {
    if (isOpen && focusRequest) focusField(focusRequest.field);
  }, [focusField, focusRequest, isOpen]);
  const symbolInputWrapRef = useRef<HTMLDivElement | null>(null);
  const nameInputWrapRef = useRef<HTMLDivElement | null>(null);
  const [formData, setFormData] = useState<Holding>({
    symbol: "",
    name: "",
    quantity: 0,
    price: 0,
    market_value: 0,
    cost_basis: undefined,
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
    setCalendarOpen(false);
    if (holding) {
      setFormData({
        ...holding,
        symbol: holding.symbol || "",
        name: holding.name || "",
        quantity: holding.quantity || 0,
        price: holding.price || 0,
        market_value: holding.market_value || 0,
        cost_basis: holding.cost_basis,
        unrealized_gain_loss: holding.unrealized_gain_loss,
        unrealized_gain_loss_pct: holding.unrealized_gain_loss_pct,
        acquisition_date: normalizeHoldingAcquisitionDate(holding.acquisition_date, "month-first") ?? holding.acquisition_date ?? "",
      });
      setErrors(validationIssue ? { [validationIssue.field]: validationIssue.message } : {});
      setFocusRequest(validationIssue ? { field: validationIssue.field, attempt: 0 } : null);
    }
  }, [holding, isOpen, validationIssue]);

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
  const handleChange = useCallback((field: keyof Holding, value: string | number | undefined) => {
    setFormData(prev => {
      const next = { ...prev, [field]: value };
      if (field === "quantity" || field === "price") return withHoldingValues(next);
      if (field === "market_value") return withHoldingValues({ ...next, market_value_unavailable: undefined }, next.market_value);
      if (field === "cost_basis") return withHoldingValues(next, next.market_value);
      return next;
    });
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

  const handleSave = useCallback(() => {
    const quoteChanged = !holding || formData.quantity !== holding.quantity || formData.price !== holding.price;
    const observedMarketValue = isCashEquivalentHolding(formData) ? formData.market_value : holding?.market_value;
    const next = withHoldingValues(formData, quoteChanged ? undefined : observedMarketValue);
    if (holding && !quoteChanged && next.market_value === holding.market_value &&
        next.cost_basis === holding.cost_basis && next.symbol.trim().toUpperCase() === holding.symbol.trim().toUpperCase()) {
      next.unrealized_gain_loss = holding.unrealized_gain_loss ?? next.unrealized_gain_loss;
      next.unrealized_gain_loss_pct = holding.unrealized_gain_loss_pct ?? next.unrealized_gain_loss_pct;
    }
    const newErrors = holdingEditorErrors(next, maxAcquisitionDate, Number(holding?.quantity) < 0);
    setErrors(newErrors);
    const field = Object.keys(newErrors)[0] as HoldingValidationField | undefined;
    if (field) {
      setFocusRequest(previous => ({ field, attempt: (previous?.attempt ?? 0) + 1 }));
      return;
    }
    onSave({
      ...next,
      symbol: next.symbol.toUpperCase(),
      acquisition_date: normalizeHoldingAcquisitionDate(next.acquisition_date),
    });
  }, [formData, holding, maxAcquisitionDate, onSave]);

  const cashLike = isCashEquivalentHolding(formData);
  const gainPreview = toHoldingViewModel({ ...formData, client_id: "holding-editor" }, 0);
  const isNewHolding = !holding?.symbol;

  return (
    // repositionInputs={false}: with ios.scrollEnabled=false + Keyboard
    // resize:"none", the app owns keyboard avoidance; let vaul not fight it.
    <Drawer
      open={isOpen}
      onOpenChange={(open) => !open && onClose()}
      repositionInputs={false}
    >
      <DrawerContent
        className={cn(financeStyles.detail, financeStyles.holdingEditor)}
        onOpenAutoFocus={(event) => {
          if (validationIssue) {
            event.preventDefault();
            focusField(validationIssue.field);
          }
        }}
        onEscapeKeyDown={(event) => {
          if (calendarOpen) {
            event.preventDefault();
            setCalendarOpen(false);
          }
        }}
      >
        <DrawerHeader className="shrink-0">
          <DrawerTitle className="ui-text-page-title">
            {isNewHolding ? "Add Holding" : "Edit Holding"}
          </DrawerTitle>
          <DrawerDescription className="sr-only">
            Review the holding details before saving.
          </DrawerDescription>
        </DrawerHeader>

        <div ref={formRef} className="min-h-0 space-y-4 overflow-y-auto px-4 py-2 md:space-y-2.5">
          {/* Symbol */}
          <div>
            <label htmlFor="holding-symbol" className="ui-text-form-label mb-1 block">
              Symbol <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <div ref={symbolInputWrapRef} className="relative">
              <input
                id="holding-symbol"
                aria-invalid={Boolean(errors.symbol)}
                aria-describedby={errors.symbol ? "holding-symbol-error" : undefined}
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
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
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
              <p id="holding-symbol-error" className="ui-text-row-description mt-1 text-destructive">{errors.symbol}</p>
            )}
          </div>

          {/* Name */}
          <div>
            <label htmlFor="holding-name" className="ui-text-form-label mb-1 block">
              Company Name <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <div ref={nameInputWrapRef} className="relative">
              <input
                id="holding-name"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "holding-name-error" : undefined}
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
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
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
              <p id="holding-name-error" className="ui-text-row-description mt-1 text-destructive">{errors.name}</p>
            )}
          </div>

          {/* Quantity & Price Row */}
          {!cashLike ? <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="holding-quantity" className="ui-text-form-label mb-1 block">
                Quantity <span className="text-destructive" aria-hidden="true">*</span>
              </label>
	              <input
                id="holding-quantity"
                aria-invalid={Boolean(errors.quantity)}
                aria-describedby={errors.quantity ? "holding-quantity-error" : undefined}
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
                <p id="holding-quantity-error" className="ui-text-row-description mt-1 text-destructive">{errors.quantity}</p>
              )}
            </div>

            <div>
              <label htmlFor="holding-price" className="ui-text-form-label mb-1 block">
                Price <span className="text-destructive" aria-hidden="true">*</span>
              </label>
	              <input
                id="holding-price"
                aria-invalid={Boolean(errors.price)}
                aria-describedby={errors.price ? "holding-price-error" : undefined}
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
                <p id="holding-price-error" className="ui-text-row-description mt-1 text-destructive">{errors.price}</p>
              )}
            </div>
          </div> : null}

          {/* Cash retains its reported balance; stock value follows shares and price. */}
          <div>
            <label htmlFor="holding-market-value" className="block text-sm text-muted-foreground font-medium mb-1">
              {cashLike ? "Cash balance" : "Market Value (Auto-calculated)"}
            </label>
            <input
              id="holding-market-value"
              aria-invalid={Boolean(errors.market_value)}
              aria-describedby={errors.market_value ? "holding-market-value-error" : undefined}
              type={cashLike ? "number" : "text"}
              value={cashLike ? (Number.isFinite(formData.market_value) ? formData.market_value : "") : `$${formData.market_value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              onChange={cashLike ? event => handleChange("market_value", Number(event.target.value)) : undefined}
              step={cashLike ? "0.01" : undefined}
              readOnly={!cashLike}
              className={cn(
                "w-full px-4 py-3 h-12 rounded-xl border bg-muted/50 text-muted-foreground font-medium",
                errors.market_value ? "border-red-500" : "border-border"
              )}
            />
            {errors.market_value && (
              <p id="holding-market-value-error" className="ui-text-row-description mt-1 text-destructive">{errors.market_value}</p>
            )}
          </div>

          {/* Cost Basis */}
          <div>
            <label htmlFor="holding-cost-basis" className="ui-text-form-label mb-1 block">
              Cost Basis (Total)
            </label>
            <input
              id="holding-cost-basis"
              aria-invalid={Boolean(errors.cost_basis)}
              aria-describedby={errors.cost_basis ? "holding-cost-basis-error" : undefined}
              type="number"
              value={formData.cost_basis ?? ""}
              onChange={(e) => handleChange("cost_basis", e.target.value === "" ? undefined : parseFloat(e.target.value))}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="w-full px-4 py-3 h-12 rounded-xl border border-border bg-background outline-none focus:border-primary transition-colors"
            />
            {errors.cost_basis && (
              <p id="holding-cost-basis-error" className="ui-text-row-description mt-1 text-destructive">{errors.cost_basis}</p>
            )}
          </div>

          <HoldingAcquisitionDateField
            value={formData.acquisition_date}
            max={maxAcquisitionDate}
            error={errors.acquisition_date}
            calendarOpen={calendarOpen}
            onCalendarOpenChange={setCalendarOpen}
            onChange={(value) => handleChange("acquisition_date", value)}
          />

          {/* Gain/Loss Preview */}
          {!cashLike && (gainPreview.gainLossValue !== null || gainPreview.gainLossPct !== null) && (
            <div className="p-4 rounded-2xl bg-muted/30 border border-border/50">
              <p className="ui-text-row-description text-muted-foreground">Unrealized gain / loss</p>
              <HoldingGainLoss holding={gainPreview} showPercentage className="ui-text-row-label-emphasized mt-1 block tabular-nums" />
            </div>
          )}
        </div>
 
        <DrawerFooter className="shrink-0 border-t bg-background/80 pb-[max(1rem,var(--app-safe-area-bottom-effective))]">
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
              variant="none"
              effect="fill"
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
