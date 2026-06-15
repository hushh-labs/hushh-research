"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  BarChart3,
  Bell,
  ChevronRight,
  CirclePlus,
  Compass,
  LineChart,
  MessageCircle,
  Mic,
  PieChart,
  Search,
  Shield,
  Star,
  Store,
  TrendingUp,
  UserRound,
  WalletCards,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import {
  kaiPreviewDockActiveItemClassName,
  kaiPreviewDockItemClassName,
  kaiPreviewDockSurfaceClassName,
  kaiPreviewEyebrowClassName,
  kaiPreviewPageTitleClassName,
  kaiPreviewSectionTitleClassName,
  marketSurfaceVariablesClassName,
} from "@/components/kai/shared/market-surface-theme";
import { cn } from "@/lib/utils";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

const analysisRootClassName = cn(
  marketSurfaceVariablesClassName,
  "relative isolate mx-auto flex min-h-screen w-full !max-w-none flex-col overflow-x-hidden !px-0 pb-0",
  "bg-[color:var(--one-bg)] font-sans text-[color:var(--one-fg)] antialiased",
  "[--one-bg:#ffffff] [--one-card:#ffffff] [--one-surface:#f2f2f7]",
  "[--one-hairline:rgba(0,0,0,0.08)] [--one-line:rgba(0,0,0,0.06)]",
  "[--one-fg:#1d1d1f] [--one-fg2:rgba(0,0,0,0.55)] [--one-fg3:rgba(0,0,0,0.42)]",
  "[--one-blue:#0071e3] [--one-link:#0066cc] [--one-blue-t:rgba(0,113,227,0.10)]",
  "[--one-up:#34c759] [--one-up-t:rgba(52,199,89,0.12)]",
  "[--one-down:#ff3b30] [--one-down-t:rgba(255,59,48,0.10)]",
  "[--one-indigo:#5856d6] [--one-indigo-t:rgba(88,86,214,0.12)]",
  "[--one-orange:#ff9500] [--one-orange-t:rgba(255,149,0,0.14)]",
  "[--one-teal:#30b0c7] [--one-teal-t:rgba(48,176,199,0.13)]",
  "[--one-purple:#af52de] [--one-purple-t:rgba(175,82,222,0.12)]",
  "[--one-glass-fill:linear-gradient(135deg,rgba(255,255,255,0.45),rgba(255,255,255,0.16))]",
  "[--one-glass-float:0_16px_38px_-20px_rgba(0,0,0,0.28),0_4px_12px_-8px_rgba(0,0,0,0.10)]",
  "[--one-gutter:clamp(16px,4.6vw,22px)]"
);

const analysisGlassClassName = cn(
  "relative bg-[image:var(--one-glass-fill)] backdrop-blur-[20px] backdrop-saturate-[200%]",
  "shadow-[var(--one-glass-float),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_1px_rgba(0,0,0,0.06)]",
  "ring-1 ring-white/55"
);

const analysisCardClassName =
  "rounded-[20px] bg-[color:var(--one-card)] p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]";

const RANGE_KEYS = ["1W", "1M", "3M", "1Y", "All"] as const;
type RangeKey = (typeof RANGE_KEYS)[number];

const RANGE_META: Record<
  RangeKey,
  { value: string; pill: string; area: string; line: string }
> = {
  "1W": {
    value: "$142,893",
    pill: "+2.4% - 1W",
    area: "M0 80 L34 74 L68 78 L102 66 L136 70 L170 58 L204 62 L238 48 L272 52 L306 40 L340 32 L340 130 L0 130 Z",
    line: "M0 80 L34 74 L68 78 L102 66 L136 70 L170 58 L204 62 L238 48 L272 52 L306 40 L340 32",
  },
  "1M": {
    value: "$142,893",
    pill: "+4.9% - 1M",
    area: "M0 96 L34 88 L68 91 L102 78 L136 82 L170 70 L204 66 L238 58 L272 48 L306 39 L340 31 L340 130 L0 130 Z",
    line: "M0 96 L34 88 L68 91 L102 78 L136 82 L170 70 L204 66 L238 58 L272 48 L306 39 L340 31",
  },
  "3M": {
    value: "$142,893",
    pill: "+8.1% - 3M",
    area: "M0 102 L34 95 L68 86 L102 90 L136 74 L170 68 L204 63 L238 52 L272 56 L306 41 L340 28 L340 130 L0 130 Z",
    line: "M0 102 L34 95 L68 86 L102 90 L136 74 L170 68 L204 63 L238 52 L272 56 L306 41 L340 28",
  },
  "1Y": {
    value: "$142,893",
    pill: "+14.8% - 1Y",
    area: "M0 110 L34 102 L68 97 L102 88 L136 92 L170 74 L204 69 L238 58 L272 48 L306 36 L340 24 L340 130 L0 130 Z",
    line: "M0 110 L34 102 L68 97 L102 88 L136 92 L170 74 L204 69 L238 58 L272 48 L306 36 L340 24",
  },
  All: {
    value: "$142,893",
    pill: "+37.6% - All",
    area: "M0 114 L34 108 L68 112 L102 95 L136 88 L170 82 L204 67 L238 60 L272 44 L306 35 L340 22 L340 130 L0 130 Z",
    line: "M0 114 L34 108 L68 112 L102 95 L136 88 L170 82 L204 67 L238 60 L272 44 L306 35 L340 22",
  },
};

type Tone = "indigo" | "orange" | "teal" | "blue" | "purple" | "ai";

function openAnalysisHref(href: string) {
  requestInternalAppNavigation({ href, scroll: false });
}

function toneClassName(tone: Tone): string {
  if (tone === "orange") return "bg-[color:var(--one-orange-t)] text-[color:var(--one-orange)]";
  if (tone === "teal") return "bg-[color:var(--one-teal-t)] text-[color:var(--one-teal)]";
  if (tone === "blue") return "bg-[color:var(--one-blue-t)] text-[color:var(--one-link)]";
  if (tone === "purple") return "bg-[color:var(--one-purple-t)] text-[color:var(--one-purple)]";
  if (tone === "ai") return "bg-[color:var(--one-blue)] text-white";
  return "bg-[color:var(--one-indigo-t)] text-[color:var(--one-indigo)]";
}

function SectionHeader({
  title,
  icon: Icon,
  tone,
  action,
}: {
  title: string;
  icon: LucideIcon;
  tone: Tone;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className={kaiPreviewSectionTitleClassName} role="heading" aria-level={2}>
        <span className={cn("grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg", toneClassName(tone))}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
      {action}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "muted",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "up" | "down" | "muted";
}) {
  return (
    <div className="rounded-[14px] bg-[color:var(--one-card)] px-[13px] py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
      <p className="text-[12px] font-medium text-[color:var(--one-fg2)]">{label}</p>
      <p className="mt-1.5 text-[17px] font-semibold text-[color:var(--one-fg)] tabular-nums">{value}</p>
      <p
        className={cn(
          "mt-0.5 text-[12px] font-semibold tabular-nums",
          tone === "up" && "text-[color:var(--one-up)]",
          tone === "down" && "text-[color:var(--one-down)]",
          tone === "muted" && "font-medium text-[color:var(--one-fg3)]"
        )}
      >
        {sub}
      </p>
    </div>
  );
}

function BrandLogo({ symbol, className }: { symbol: string; className?: string }) {
  const baseClassName =
    "relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[10px] font-bold";
  if (symbol === "TSLA") {
    return (
      <span className={cn(baseClassName, "bg-[#e82127] text-white", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
          <path d="M12 5.362l2.475-3.026s4.245.09 8.471 2.054c-1.082 1.636-3.231 2.438-3.231 2.438-.146-1.439-1.154-1.79-4.354-1.79L12 24 8.619 5.034c-3.18 0-4.188.354-4.335 1.792 0 0-2.146-.795-3.229-2.43C5.28 2.431 9.525 2.34 9.525 2.34L12 5.362l-.004.002H12v-.002zm0-3.899c3.415-.03 7.326.528 11.328 2.28.535-.968.672-1.395.672-1.395C19.625.612 15.528.015 12 0 8.472.015 4.375.61 0 2.349c0 0 .195.525.672 1.396C4.674 1.989 8.585 1.435 12 1.46v.003z" />
        </svg>
      </span>
    );
  }
  if (symbol === "AAPL") {
    return (
      <span className={cn(baseClassName, "border border-[color:var(--one-hairline)] bg-white text-[#111111]", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
          <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
        </svg>
      </span>
    );
  }
  if (symbol === "NVDA") {
    return (
      <span className={cn(baseClassName, "bg-[#76b900] text-white", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
          <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z" />
        </svg>
      </span>
    );
  }
  if (symbol === "AMZN") {
    return (
      <span className={cn(baseClassName, "bg-[#232f3e] text-white", className)} aria-hidden="true">
        <span className="text-[14px] leading-none">a</span>
        <svg viewBox="0 0 24 8" className="absolute bottom-[5px] left-[21%] h-[7px] w-[58%] text-[#ff9900]">
          <path d="M2 2c5.5 4 14.5 4 20-.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M19.3 1l3.2-.4-1.1 2.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className={cn(baseClassName, "bg-[#c8102e] text-white", className)} aria-hidden="true">
      {symbol.slice(0, 1)}
    </span>
  );
}

function HoldingRow({
  symbol,
  title,
  description,
  value,
  change,
  tone,
}: {
  symbol: string;
  title: string;
  description: string;
  value: string;
  change: string;
  tone: "up" | "down" | "muted";
}) {
  return (
    <div className="flex items-center gap-3 border-t border-[color:var(--one-line)] px-[15px] py-3 first:border-t-0">
      <BrandLogo symbol={symbol} />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold leading-tight text-[color:var(--one-fg)]">{title}</p>
        <p className="mt-0.5 truncate text-[12px] text-[color:var(--one-fg3)]">{description}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[14px] font-semibold text-[color:var(--one-fg)] tabular-nums">{value}</p>
        <p
          className={cn(
            "text-[12px] font-semibold tabular-nums",
            tone === "up" && "text-[color:var(--one-up)]",
            tone === "down" && "text-[color:var(--one-down)]",
            tone === "muted" && "text-[color:var(--one-fg3)]"
          )}
        >
          {change}
        </p>
      </div>
    </div>
  );
}

function AllocationSection() {
  const [allocationMode, setAllocationMode] = useState<"asset" | "sector">("asset");
  const rows =
    allocationMode === "asset"
      ? [
          { label: "Stocks", pct: "64%", color: "bg-[color:var(--one-indigo)]", width: "64%" },
          { label: "Bonds", pct: "22%", color: "bg-[color:var(--one-blue)]", width: "22%" },
          { label: "Cash", pct: "14%", color: "bg-[color:var(--one-teal)]", width: "14%" },
        ]
      : [
          { label: "Technology", pct: "38%", color: "bg-[color:var(--one-indigo)]", width: "38%" },
          { label: "Consumer Cyclical", pct: "31%", color: "bg-[color:var(--one-blue)]", width: "31%" },
          { label: "Consumer Defensive", pct: "12%", color: "bg-[color:var(--one-teal)]", width: "12%" },
          { label: "Healthcare", pct: "8%", color: "bg-[color:var(--one-purple)]", width: "8%" },
          { label: "Other", pct: "11%", color: "bg-[color:var(--one-fg3)]", width: "11%" },
        ];

  return (
    <section className="mt-8">
      <SectionHeader
        title="Allocation"
        icon={PieChart}
        tone="indigo"
        action={
          <div className="inline-flex rounded-full bg-[color:var(--one-surface)] p-[3px]">
            {[
              { id: "asset" as const, label: "Asset" },
              { id: "sector" as const, label: "Sector" },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setAllocationMode(item.id)}
                className={cn(
                  "rounded-full px-[13px] py-[5px] text-[12px] font-semibold text-[color:var(--one-fg2)] transition-colors",
                  allocationMode === item.id &&
                    "bg-[color:var(--one-card)] text-[color:var(--one-fg)] shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      />
      <div className={analysisCardClassName}>
        <div className="flex h-3.5 overflow-hidden rounded-full">
          {rows.map((row) => (
            <span
              key={row.label}
              className={cn("mr-0.5 block h-full last:mr-0", row.color)}
              style={{ width: row.width }}
            />
          ))}
        </div>
        <div className="mt-[13px] flex flex-col gap-[9px]">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-[9px]">
              <span className={cn("h-[9px] w-[9px] shrink-0 rounded-[3px]", row.color)} />
              <span className="min-w-0 flex-1 text-[13px] font-medium text-[color:var(--one-fg)]">{row.label}</span>
              <span className="text-[13px] font-semibold tabular-nums text-[color:var(--one-fg)]">{row.pct}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AnalysisDock({ onKaiOpen }: { onKaiOpen: () => void }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const items: Array<{ label: string; href: string; icon: LucideIcon; active?: boolean }> = [
    { label: "Market", href: "/kai?preview=market", icon: Store },
    { label: "Portfolio", href: "/kai/portfolio", icon: WalletCards },
    { label: "Analysis", href: "/kai/analysis?preview=analysis", icon: LineChart, active: true },
    { label: "Connect", href: "/kai?preview=connect", icon: Compass },
    { label: "Profile", href: "/profile", icon: UserRound },
  ];

  const submitSearch = () => {
    const normalized = query.trim();
    if (!normalized) return;
    setSearchOpen(false);
    openAnalysisHref(`/kai/analysis?preview=analysis&q=${encodeURIComponent(normalized)}`);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] px-4 pb-[calc(10px+env(safe-area-inset-bottom))] sm:px-6 before:pointer-events-none before:absolute before:inset-x-[-18px] before:bottom-[-10px] before:h-[126px] before:bg-[linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,0.88)_34%,rgba(255,255,255,0.98))] before:backdrop-blur-[8px] [&>*]:relative [&>*]:z-[1]">
      <div className="relative flex items-end gap-2.5 sm:gap-3">
        {searchOpen ? (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submitSearch();
              }}
              className={cn(
                kaiPreviewDockSurfaceClassName,
                "pointer-events-auto flex h-[50px] min-w-0 flex-1 items-center gap-[9px] rounded-full px-[15px] pr-2"
              )}
            >
              <Search className="h-5 w-5 shrink-0 text-[color:var(--one-fg3)]" />
              <input
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--one-fg)] outline-none placeholder:text-[color:var(--one-fg3)]"
              />
              <button
                type="button"
                onClick={submitSearch}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white transition-transform active:scale-[0.92]"
                aria-label="Voice search"
              >
                <Mic className="h-4 w-4" />
              </button>
            </form>
            <button
              type="button"
              onClick={() => setSearchOpen(false)}
              className="pointer-events-auto flex h-[50px] shrink-0 items-center justify-center rounded-full px-1.5 text-[14px] font-semibold text-[color:var(--one-link)]"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <nav
              className={cn(
                kaiPreviewDockSurfaceClassName,
                "pointer-events-auto grid h-[58px] min-w-0 flex-1 grid-cols-5 content-center rounded-full px-1.5"
              )}
            >
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => openAnalysisHref(item.href)}
                    className={cn(
                      kaiPreviewDockItemClassName,
                      item.active && kaiPreviewDockActiveItemClassName
                    )}
                  >
                    <Icon className="h-[21px] w-[21px]" strokeWidth={1.8} />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <button
              type="button"
              onClick={onKaiOpen}
              className={cn(kaiPreviewDockSurfaceClassName, "pointer-events-auto absolute bottom-[72px] right-1 grid h-[50px] w-[50px] place-items-center rounded-full")}
              aria-label="Talk to Kai"
            >
              <span className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-[color:var(--one-blue)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]">
                <CirclePlus className="h-[15px] w-[15px]" strokeWidth={2} />
              </span>
            </button>
            <div className="pointer-events-auto flex shrink-0">
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className={cn(kaiPreviewDockSurfaceClassName, "grid h-[58px] w-[58px] place-items-center rounded-full text-[color:var(--one-fg2)] transition-transform active:scale-[0.9]")}
                aria-label="Search"
              >
                <Search className="h-5 w-5" strokeWidth={2.2} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KaiSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState([
    "Your portfolio is up 0.41% today and 3.2% ahead of the S&P over the year. Concentration in Tesla is the one thing I would watch.",
  ]);
  const [draft, setDraft] = useState("");

  const ask = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const reply = text.toLowerCase().includes("risk")
      ? "Your risk is Moderate: beta 1.18, volatility 14.2%, and max drawdown -8.4%. Tesla concentration is the main swing factor."
      : text.toLowerCase().includes("concentr")
        ? "Yes. Tesla is 31% of the portfolio, and that is above the 25% threshold where one name starts driving most movement."
        : "You are 3.2% ahead of the S&P 500 over the past year. Keep the edge by trimming concentration before adding new risk.";
    setMessages((current) => [...current, text, reply]);
    setDraft("");
  };

  if (!open) return null;

  return (
    <section className="fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[82vh] max-w-[440px] flex-col rounded-t-[28px] bg-[#f9f9fb]/95 shadow-[0_-18px_50px_-20px_rgba(0,0,0,0.40)] backdrop-blur-[22px] backdrop-saturate-[180%]">
      <div className="mx-auto mt-[9px] h-[5px] w-9 rounded-full bg-[color:var(--one-fg3)]/35" />
      <header className="flex items-center gap-[11px] border-b border-[color:var(--one-line)] px-[18px] pb-3 pt-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white">
          <MessageCircle className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block text-[17px] font-semibold text-[color:var(--one-fg)]">Kai</b>
          <span className="block truncate text-[12px] text-[color:var(--one-fg3)]">Personal intelligence - works only for you</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--one-surface)] text-[color:var(--one-fg2)]"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
        {messages.map((message, index) => (
          <div
            key={`${message}-${index}`}
            className={cn(
              "max-w-[84%] rounded-[18px] px-3.5 py-2.5 text-[14px] leading-[1.45]",
              index % 2 === 0
                ? "self-start rounded-bl-md bg-[color:var(--one-surface)] text-[color:var(--one-fg)]"
                : "self-end rounded-br-md bg-[color:var(--one-blue)] text-white"
            )}
          >
            {message}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-2">
        {["Am I too concentrated?", "Explain my risk", "How do I beat the S&P?"].map((question) => (
          <button
            key={question}
            type="button"
            onClick={() => ask(question)}
            className="rounded-full border border-[color:var(--one-hairline)] px-3 py-2 text-[13px] font-semibold text-[color:var(--one-link)]"
          >
            {question}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask(draft);
        }}
        className="flex items-center gap-[9px] border-t border-[color:var(--one-line)] px-3.5 pb-[calc(14px+env(safe-area-inset-bottom))] pt-2.5"
      >
        <div className="min-w-0 flex-1 rounded-full bg-[color:var(--one-surface)] px-4 py-2.5">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message Kai..."
            className="w-full bg-transparent text-[14px] text-[color:var(--one-fg)] outline-none placeholder:text-[color:var(--one-fg3)]"
          />
        </div>
        <button
          type="submit"
          className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white"
          aria-label="Send to Kai"
        >
          <Mic className="h-4 w-4" />
        </button>
      </form>
    </section>
  );
}

function NotificationsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <section className="fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[62vh] max-w-[440px] flex-col rounded-t-[28px] bg-[#f9f9fb]/95 shadow-[0_-18px_50px_-20px_rgba(0,0,0,0.40)] backdrop-blur-[22px] backdrop-saturate-[180%]">
      <div className="mx-auto mt-[9px] h-[5px] w-9 rounded-full bg-[color:var(--one-fg3)]/35" />
      <header className="flex items-center gap-[11px] border-b border-[color:var(--one-line)] px-[18px] pb-3 pt-3">
        <span className="min-w-0 flex-1">
          <b className="block text-[17px] font-semibold text-[color:var(--one-fg)]">Notifications</b>
          <span className="block truncate text-[12px] text-[color:var(--one-fg3)]">Signals and receipts</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--one-surface)] text-[color:var(--one-fg2)]"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {[
          { title: "Receipt signed", body: "Banking agent - credit score - 30 min - revocable", time: "2m", tone: "up" },
          { title: "Kai signal - Buy TSLA", body: "High conviction - 12+ month horizon", time: "1h", tone: "blue" },
          { title: "Markets closed soft", body: "S&P 500 -1.58% - defensives led", time: "3h", tone: "down" },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-3 border-t border-[color:var(--one-line)] px-4 py-3 first:border-t-0">
            <span
              className={cn(
                "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
                item.tone === "up" && "bg-[color:var(--one-up-t)] text-[color:var(--one-up)]",
                item.tone === "down" && "bg-[color:var(--one-down-t)] text-[color:var(--one-down)]",
                item.tone === "blue" && "bg-[color:var(--one-blue-t)] text-[color:var(--one-link)]"
              )}
            >
              <Bell className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <b className="block text-[14px] font-semibold text-[color:var(--one-fg)]">{item.title}</b>
              <span className="block text-[12px] leading-5 text-[color:var(--one-fg3)]">{item.body}</span>
            </span>
            <time className="text-[12px] text-[color:var(--one-fg3)]">{item.time}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

export function KaiAnalysisPreviewView() {
  const [range, setRange] = useState<RangeKey>("1W");
  const [kaiOpen, setKaiOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [stockQuery, setStockQuery] = useState("");
  const rangeMeta = RANGE_META[range];
  const sheetOpen = kaiOpen || notificationsOpen;
  const recentRows = useMemo(
    () => [
      { symbol: "AMZN", title: "Amazon", description: "Analyzed today - Kai debate", value: "Buy", change: "95% confidence" },
      { symbol: "BUD", title: "Anheuser-Busch", description: "Analyzed yesterday - Kai debate", value: "Buy", change: "91% confidence" },
    ],
    []
  );

  return (
    <AppPageShell
      as="div"
      width="reading"
      className={analysisRootClassName}
      data-one-analysis-preview="true"
    >
      <style>
        {`
          html:has([data-one-analysis-preview="true"]),
          body {
            background: #ffffff !important;
          }

          body:has([data-one-analysis-preview="true"]) main,
          body:has([data-one-analysis-preview="true"]) [data-top-content-anchor="true"],
          body:has([data-one-analysis-preview="true"]) [class*="overflow-y-auto"][class*="touch-pan-y"] {
            background: #ffffff !important;
          }

          nextjs-portal,
          [aria-label="Open consent inbox"] {
            display: none !important;
          }
        `}
      </style>
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-20 bg-white" />

      <div className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-[calc(190px+env(safe-area-inset-bottom))] pt-3 sm:px-[22px]">
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className={cn(kaiPreviewEyebrowClassName, "text-[color:var(--one-fg3)]")}>
                Updated 6:43 PM
              </span>
              <div className={cn("mt-1.5", kaiPreviewPageTitleClassName)} role="heading" aria-level={1}>
                Analysis
              </div>
              <p className="mt-2 max-w-[32ch] text-[14px] leading-snug text-[color:var(--one-fg2)]">
                How your portfolio is performing.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setNotificationsOpen(true)}
              className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--one-surface)] text-[color:var(--one-fg)] transition-transform active:scale-90"
              aria-label="Notifications"
            >
              <span className="absolute right-2 top-[7px] h-1.5 w-1.5 rounded-full bg-[color:var(--one-down)] shadow-[0_0_0_2px_var(--one-surface)]" />
              <Bell className="h-[17px] w-[17px]" />
            </button>
          </header>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              const query = stockQuery.trim();
              if (query) {
                openAnalysisHref(`/kai/analysis?preview=analysis&q=${encodeURIComponent(query)}`);
              }
            }}
            className="mt-3 flex h-11 items-center gap-2.5 rounded-xl bg-[color:var(--one-surface)] px-3.5"
          >
            <Search className="h-[17px] w-[17px] shrink-0 text-[color:var(--one-fg3)]" />
            <input
              type="text"
              placeholder="Analyze any stock"
              value={stockQuery}
              onChange={(event) => setStockQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--one-fg)] outline-none placeholder:text-[color:var(--one-fg3)]"
            />
            <button
              type="button"
              className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[color:var(--one-fg3)]"
              aria-label="Speak to search"
            >
              <Mic className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-3.5 flex items-start justify-between gap-3">
            <div>
              <p className="text-[13px] font-medium text-[color:var(--one-fg2)]">Portfolio value</p>
              <p className="mt-1 text-[38px] font-semibold leading-none tracking-normal text-[color:var(--one-fg)] tabular-nums">
                {rangeMeta.value}
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color:var(--one-up-t)] px-2.5 py-1 text-[12px] font-semibold text-[color:var(--one-up)] tabular-nums">
              <TrendingUp className="h-3 w-3" />
              {rangeMeta.pill}
            </span>
          </div>

          <div className="mt-1.5">
            <svg className="block h-[104px] w-full" viewBox="0 0 340 130" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="analysisPreviewGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--one-indigo)" stopOpacity="0.14" />
                  <stop offset="100%" stopColor="var(--one-indigo)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={rangeMeta.area} fill="url(#analysisPreviewGradient)" />
              <path d={rangeMeta.line} fill="none" stroke="var(--one-indigo)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="mt-1.5 flex gap-1.5">
            {RANGE_KEYS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setRange(item)}
                className={cn(
                  "flex-1 rounded-full py-[7px] text-[12px] font-semibold text-[color:var(--one-fg2)] transition-colors",
                  range === item && "bg-[color:var(--one-surface)] text-[color:var(--one-fg)]"
                )}
              >
                {item}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setKaiOpen(true)}
            className={cn(analysisGlassClassName, "mt-3 flex w-full items-center gap-[11px] rounded-2xl px-3.5 py-2.5 text-left transition-transform active:scale-[0.99]")}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white">
              <MessageCircle className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 text-[13px] leading-snug text-[color:var(--one-fg)]">
              <b className="font-semibold">Kai:</b> Tesla drove most of this week's gain. Concentration is your main risk - ask me for a rebalance plan.
            </span>
            <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[color:var(--one-fg3)]" />
          </button>

          <section className="mt-8">
            <SectionHeader title="Returns" icon={TrendingUp} tone="indigo" />
            <div className="grid grid-cols-2 gap-2.5">
              <StatCard label="Total return" value="+$18,420" sub="+14.8% - 1Y" tone="up" />
              <StatCard label="Today" value="+$579" sub="+0.41%" tone="up" />
              <StatCard label="CAGR" value="12.6%" sub="Since inception" />
              <StatCard label="vs S&P 500" value="+3.2%" sub="Ahead - 1Y" tone="up" />
            </div>
          </section>

          <AllocationSection />

          <section className="mt-8">
            <SectionHeader title="Risk" icon={Shield} tone="orange" />
            <div className={analysisCardClassName}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-semibold text-[color:var(--one-fg)]">Diversification score</span>
                <span className="text-[13px] font-semibold text-[color:var(--one-orange)]">62 / 100</span>
              </div>
              <div className="mt-2 h-[7px] overflow-hidden rounded-full bg-[color:var(--one-surface)]">
                <span className="block h-full w-[62%] rounded-full bg-[color:var(--one-orange)]" />
              </div>
              <div className="mt-3.5 grid grid-cols-2 gap-2.5">
                <StatCard label="Risk profile" value="Moderate" sub="64 / 22 / 14 mix" />
                <StatCard label="Beta" value="1.18" sub="vs S&P 500" />
                <StatCard label="Volatility" value="14.2%" sub="1Y annualised" />
                <StatCard label="Max drawdown" value="-8.4%" sub="Past year" />
              </div>
              <div className="mt-3.5 flex items-start gap-2.5 rounded-[13px] bg-[color:var(--one-orange-t)] px-[13px] py-3">
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--one-orange)]" />
                <p className="text-[13px] leading-snug text-[color:var(--one-fg)]">
                  <b className="font-semibold">Tesla is 31% of your portfolio.</b> A single name above 25% drives most of your swings - ask Kai for a rebalance plan.
                </p>
              </div>
            </div>
          </section>

          <section className="mt-8">
            <SectionHeader title="Today's impact" icon={Zap} tone="blue" />
            <div className="overflow-hidden rounded-[20px] bg-[color:var(--one-card)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              <HoldingRow symbol="TSLA" title="Tesla" description="38 sh - top contributor" value="+$467" change="+5.20%" tone="up" />
              <HoldingRow symbol="AAPL" title="Apple" description="64 sh" value="+$132" change="+1.10%" tone="up" />
              <HoldingRow symbol="NVDA" title="NVIDIA" description="21 sh - top detractor" value="-$20" change="-0.80%" tone="down" />
            </div>
          </section>

          <section className="mt-8">
            <SectionHeader title="You vs S&P 500" icon={BarChart3} tone="teal" />
            <div className={analysisCardClassName}>
              <svg className="mt-1 block h-[100px] w-full" viewBox="0 0 300 90" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0 66 L50 62 L100 64 L150 52 L200 54 L250 42 L300 36" fill="none" stroke="var(--one-fg3)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 6" />
                <path d="M0 64 L50 56 L100 60 L150 42 L200 46 L250 28 L300 20" fill="none" stroke="var(--one-indigo)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div className="mt-2.5 flex flex-wrap gap-4">
                <span className="inline-flex items-center gap-[7px] text-[12px] font-semibold text-[color:var(--one-fg2)]">
                  <i className="h-[3px] w-3.5 rounded-full bg-[color:var(--one-indigo)]" />
                  You <b className="font-semibold text-[color:var(--one-fg)]">+14.8%</b>
                </span>
                <span className="inline-flex items-center gap-[7px] text-[12px] font-semibold text-[color:var(--one-fg2)]">
                  <i className="h-[3px] w-3.5 rounded-full bg-[color:var(--one-fg3)]" />
                  S&P 500 <b className="font-semibold text-[color:var(--one-fg)]">+11.6%</b>
                </span>
              </div>
              <p className="mt-2.5 text-[13px] leading-snug text-[color:var(--one-fg2)]">
                You are <b className="font-semibold text-[color:var(--one-fg)]">3.2% ahead</b> of the index over the past year - most of the edge came from Tesla.
              </p>
            </div>
          </section>

          <section className="mt-8">
            <SectionHeader title="Recent analyses" icon={Star} tone="ai" />
            <div className="overflow-hidden rounded-[20px] bg-[color:var(--one-card)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              {recentRows.map((row) => (
                <HoldingRow
                  key={row.symbol}
                  symbol={row.symbol}
                  title={row.title}
                  description={row.description}
                  value={row.value}
                  change={row.change}
                  tone="up"
                />
              ))}
            </div>
          </section>
        </main>

        <AnalysisDock onKaiOpen={() => setKaiOpen(true)} />
      </div>

      {sheetOpen ? (
        <button
          type="button"
          aria-label="Close overlay"
          className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[6px]"
          onClick={() => {
            setKaiOpen(false);
            setNotificationsOpen(false);
          }}
        />
      ) : null}
      <KaiSheet open={kaiOpen} onClose={() => setKaiOpen(false)} />
      <NotificationsSheet open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    </AppPageShell>
  );
}
