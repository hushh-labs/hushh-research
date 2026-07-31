"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@/lib/morphy-ux/ui/combobox";
import { cn } from "@/lib/utils";
import {
  getTickerUniverseSnapshot,
  preloadTickerUniverse,
  searchTickerUniverseRemote,
  searchTickerUniverse,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";
import { ROUTES } from "@/lib/navigation/routes";

// Top popular stocks for instant suggestion (offline fallback)
const TOP_STOCKS = [
  { value: "AAPL", label: "Apple Inc." },
  { value: "MSFT", label: "Microsoft Corp." },
  { value: "GOOGL", label: "Alphabet Inc." },
  { value: "AMZN", label: "Amazon.com Inc." },
  { value: "NVDA", label: "NVIDIA Corp." },
  { value: "TSLA", label: "Tesla Inc." },
  { value: "META", label: "Meta Platforms Inc." },
  { value: "BRK.B", label: "Berkshire Hathaway" },
  { value: "LLY", label: "Eli Lilly & Co." },
  { value: "V", label: "Visa Inc." },
  { value: "TSM", label: "Taiwan Semiconductor" },
  { value: "AVGO", label: "Broadcom Inc." },
  { value: "JPM", label: "JPMorgan Chase" },
  { value: "WMT", label: "Walmart Inc." },
  { value: "XOM", label: "Exxon Mobil Corp." },
  { value: "MA", label: "Mastercard Inc." },
  { value: "UNH", label: "UnitedHealth Group" },
  { value: "PG", label: "Procter & Gamble" },
  { value: "JNJ", label: "Johnson & Johnson" },
  { value: "HD", label: "Home Depot Inc." },
  { value: "MRK", label: "Merck & Co." },
  { value: "COST", label: "Costco Wholesale" },
  { value: "ABBV", label: "AbbVie Inc." },
  { value: "CVX", label: "Chevron Corp." },
  { value: "CRM", label: "Salesforce Inc." },
  { value: "BAC", label: "Bank of America" },
  { value: "AMD", label: "Advanced Micro Devices" },
  { value: "NFLX", label: "Netflix Inc." },
  { value: "PEP", label: "PepsiCo Inc." },
  { value: "KO", label: "Coca-Cola Co." },
  { value: "TMO", label: "Thermo Fisher" },
  { value: "ADBE", label: "Adobe Inc." },
  { value: "DIS", label: "Walt Disney Co." },
  { value: "MCD", label: "McDonald's Corp." },
  { value: "CSCO", label: "Cisco Systems" },
  { value: "ABT", label: "Abbott Labs" },
  { value: "DHR", label: "Danaher Corp." },
  { value: "INTC", label: "Intel Corp." },
  { value: "NKE", label: "Nike Inc." },
  { value: "VZ", label: "Verizon Comm." },
  { value: "CMCSA", label: "Comcast Corp." },
  { value: "INTU", label: "Intuit Inc." },
  { value: "QCOM", label: "Qualcomm Inc." },
  { value: "IBM", label: "IBM Corp." },
  { value: "TXN", label: "Texas Instruments" },
  { value: "AMGN", label: "Amgen Inc." },
  { value: "SPY", label: "S&P 500 ETF" },
  { value: "QQQ", label: "Nasdaq 100 ETF" },
  { value: "IWM", label: "Russell 2000 ETF" },
  { value: "GLD", label: "Gold Trust" },
];

/** Returns true when `text` looks like a valid 1-5 letter ticker */
function isTickerLike(text: string): boolean {
  return /^[A-Z0-9]{1,5}(?:[.-][A-Z0-9]{1,3})?$/.test(text.toUpperCase());
}

/** Returns true if text contains invalid characters for a ticker */
function hasInvalidChars(text: string): boolean {
  return !/^[A-Za-z0-9.-]*$/.test(text);
}

type StockSearchItem = {
  value: string;
  label: string;
  keywords: string;
  group: "remote" | "escape" | "popular";
};

export function StockSearch({
  onSelect,
  className,
}: {
  onSelect?: (ticker: string) => void;
  className?: string;
}) {
  const router = useRouter();

  const [search, setSearch] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const initialUniverse = React.useMemo(() => getTickerUniverseSnapshot(), []);
  const [universe, setUniverse] = React.useState<TickerUniverseRow[] | null>(initialUniverse);
  const [universeLoading, setUniverseLoading] = React.useState(!initialUniverse);
  const [remoteMatches, setRemoteMatches] = React.useState<TickerUniverseRow[]>([]);
  const [remoteLoading, setRemoteLoading] = React.useState(false);

  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState<string | null>(null);

  // Preload full ticker universe once (cached in memory + localStorage)
  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!initialUniverse) {
          setUniverseLoading(true);
        }
        const rows = await preloadTickerUniverse();
        if (!cancelled) setUniverse(rows);
      } catch {
        // Keep universe null; we still have TOP_STOCKS as offline fallback.
      } finally {
        if (!cancelled) setUniverseLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialUniverse]);

  // Keep ticker search continuous while local universe is still loading by querying backend cache.
  React.useEffect(() => {
    const q = search.trim();
    if (!q) {
      setRemoteMatches([]);
      setRemoteLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setRemoteLoading(true);
        const rows = await searchTickerUniverseRemote(q, 25);
        if (cancelled) return;
        setRemoteMatches(rows);
        if (rows.length > 0) {
          setUniverse((prev) => {
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
        if (!cancelled) setRemoteLoading(false);
      }
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  const knownTickerSet = React.useMemo(() => {
    const out = new Set<string>();
    for (const row of universe ?? []) {
      out.add(row.ticker.toUpperCase());
    }
    for (const row of remoteMatches) {
      out.add(row.ticker.toUpperCase());
    }
    return out;
  }, [universe, remoteMatches]);

  const escapeTicker = React.useMemo(() => {
    const upper = search.trim().toUpperCase();
    if (!upper || !isTickerLike(upper)) return null;

    // If it already appears in local results, don't show escape hatch.
    if (knownTickerSet.has(upper)) return null;

    return upper;
  }, [knownTickerSet, search]);

  const handleSelect = (rawValue: string) => {
    const ticker = rawValue.toUpperCase();

    if (!isTickerLike(ticker)) {
      setError("Invalid ticker symbol");
      toast.error("Invalid ticker symbol");
      return;
    }

    // If we have the universe loaded, require the ticker to exist.
    if (knownTickerSet.size > 0 && !knownTickerSet.has(ticker)) {
      setError("Ticker not found");
      toast.error("Ticker not found", { description: "Please enter a valid stock symbol." });
      return;
    }

    setError(null);
    setSearch(ticker);
    setValue(ticker);
    setOpen(false);

    if (onSelect) {
      // Preferred: delegate to parent (KaiSearchBar/KaiFlow) so behavior matches Prime Assets.
      onSelect(ticker);
      return;
    }

    // Fallback: navigate to analysis route.
    // Note: analysis start is driven by Zustand in KaiFlow; query param is only a fallback.
    router.push(`${ROUTES.KAI_ANALYSIS}?ticker=${ticker}`);
  };

  const items: StockSearchItem[] = React.useMemo(() => {
    const q = search.trim();

    const localMatches: StockSearchItem[] = universe
      ? searchTickerUniverse(universe, q, 25).map((r) => ({
          value: r.ticker.toUpperCase(),
          label: `${r.ticker.toUpperCase()} — ${r.title ?? ""}`.trim(),
          keywords: `${r.ticker} ${r.title ?? ""} ${r.exchange ?? ""} ${r.cik ?? ""}`,
          group: "remote", // keep existing rendering/group label
        }))
      : [];
    const remoteResults: StockSearchItem[] = remoteMatches.map((r) => ({
      value: r.ticker.toUpperCase(),
      label: `${r.ticker.toUpperCase()} — ${r.title ?? ""}`.trim(),
      keywords: `${r.ticker} ${r.title ?? ""} ${r.exchange ?? ""} ${r.cik ?? ""}`,
      group: "remote",
    }));

    const escapeItems: StockSearchItem[] = escapeTicker
      ? [
          {
            value: escapeTicker,
            label: `${escapeTicker} — Type any ticker`,
            keywords: escapeTicker,
            group: "escape",
          },
        ]
      : [];

    // Popular stocks are only shown when search is empty (initial suggestions)
    const popularItems: StockSearchItem[] = q
      ? []
      : TOP_STOCKS.map((s) => ({
          value: s.value,
          label: `${s.value} — ${s.label}`,
          keywords: `${s.value} ${s.label}`,
          group: "popular",
        }));

    // Dedupe by ticker value (local wins over escape/popular)
    const byValue = new Map<string, StockSearchItem>();
    for (const it of [...popularItems, ...escapeItems, ...remoteResults, ...localMatches]) {
      byValue.set(it.value, it);
    }

    return Array.from(byValue.values());
  }, [escapeTicker, remoteMatches, search, universe]);

  const filteredItems = items;

  const showRemoteGroup = filteredItems.some((i) => i.group === "remote");
  const showEscapeGroup = filteredItems.some((i) => i.group === "escape");
  const showPopularGroup = filteredItems.some((i) => i.group === "popular");

  return (
    <div className={cn("w-full", className)}>
      <Combobox
        open={open}
        onOpenChange={setOpen}
        value={value}
        onValueChange={(val) => {
          if (val) handleSelect(val);
        }}
        items={filteredItems}
      >
        <ComboboxInput
          placeholder="Analyze a stock..."
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            if (hasInvalidChars(next)) return;
            setSearch(next);
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSelect(search.trim());
            }
          }}
          onFocus={() => setOpen(true)}
          className={cn(
            "w-full rounded-full text-muted-foreground",
            "pointer-events-auto"
          )}
          showClear
          showTrigger
        >
          <ComboboxValue />
        </ComboboxInput>

        <ComboboxContent className="w-[var(--anchor-width)]">
          <ComboboxList>
            <ComboboxEmpty>
              {universeLoading || remoteLoading ? "Loading tickers…" : "No results found."}
            </ComboboxEmpty>

            {showRemoteGroup && (
              <ComboboxGroup>
                <div className="px-2 py-1.5 text-xs text-muted-foreground pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm">
                  All SEC tickers
                </div>
                <ComboboxCollection>
                  {(item: StockSearchItem) =>
                    item.group === "remote" ? (
                      <ComboboxItem
                        key={`remote-${item.value}`}
                        className="cursor-pointer"
                        // Morphy safety: ensure tap/click selects even if Base UI press handling is flaky.
                        onClick={() => handleSelect(item.value)}
                      >
                        <div className="grid w-full grid-cols-[72px_1fr] items-center gap-2">
                          <span className="font-semibold tabular-nums">{item.value}</span>
                          <span className="truncate text-muted-foreground">
                            {item.label.replace(`${item.value} — `, "")}
                          </span>
                        </div>
                      </ComboboxItem>
                    ) : null
                  }
                </ComboboxCollection>
              </ComboboxGroup>
            )}

            {showEscapeGroup && (
              <ComboboxGroup>
                <div className="px-2 py-1.5 text-xs text-muted-foreground pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm">
                  Type any ticker
                </div>
                <ComboboxCollection>
                  {(item: StockSearchItem) =>
                    item.group === "escape" ? (
                      <ComboboxItem
                        key={`escape-${item.value}`}
                        className="cursor-pointer"
                        onClick={() => handleSelect(item.value)}
                      >
                        <div className="grid w-full grid-cols-[72px_1fr] items-center gap-2">
                          <span className="font-semibold tabular-nums">{item.value}</span>
                          <span className="truncate text-muted-foreground">Type any ticker</span>
                        </div>
                      </ComboboxItem>
                    ) : null
                  }
                </ComboboxCollection>
              </ComboboxGroup>
            )}

            {showPopularGroup && (
              <ComboboxGroup>
                <div className="px-2 py-1.5 text-xs text-muted-foreground pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm">
                  Popular Stocks
                </div>
                <ComboboxCollection>
                  {(item: StockSearchItem) =>
                    item.group === "popular" ? (
                      <ComboboxItem
                        key={`popular-${item.value}`}
                        className="cursor-pointer"
                        onClick={() => handleSelect(item.value)}
                      >
                        <div className="grid w-full grid-cols-[72px_1fr] items-center gap-2">
                          <span className="font-semibold tabular-nums">{item.value}</span>
                          <span className="truncate text-muted-foreground">
                            {item.label.replace(`${item.value} — `, "")}
                          </span>
                        </div>
                      </ComboboxItem>
                    ) : null
                  }
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      {error && (
        <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-xs font-medium text-red-500">
          {error}
        </div>
      )}
    </div>
  );
}
