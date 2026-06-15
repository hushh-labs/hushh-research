"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  CirclePlus,
  Compass,
  LineChart,
  MessageCircle,
  Mic,
  Minus,
  Search,
  ShieldCheck,
  Star,
  Store,
  UserRound,
  UsersRound,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import {
  kaiPreviewDockActiveItemClassName,
  kaiPreviewDockFrameClassName,
  kaiPreviewDockItemClassName,
  kaiPreviewDockSurfaceClassName,
  kaiPreviewEyebrowClassName,
  kaiPreviewPageTitleClassName,
  kaiPreviewSectionTitleClassName,
  marketSurfaceVariablesClassName,
} from "@/components/kai/shared/market-surface-theme";
import { cn } from "@/lib/utils";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

type ConnectTone = "indigo" | "teal" | "orange" | "purple" | "blue";
type DirectoryMode = "advisors" | "firms";

type AdvisorProfile = {
  id: string;
  kind: DirectoryMode;
  name: string;
  credential: string;
  role: string;
  firm: string;
  initials: string;
  tone: ConnectTone;
  summary: string;
  meta: string;
  fee: string;
  monthly: string;
  rating: string;
  aum: string;
  experience: string;
  registration: string;
  certifications: string[];
  about: string;
};

const CONNECT_PROFILES: AdvisorProfile[] = [
  {
    id: "sc",
    kind: "advisors",
    name: "Sarah Chen",
    credential: "CFP",
    role: "Advisor",
    firm: "Meridian Wealth",
    initials: "SC",
    tone: "indigo",
    summary: "Saves tax on your gains",
    meta: "Saves tax on your gains - 0.60% - 4.9",
    fee: "0.60%",
    monthly: "~$71/mo for you",
    rating: "4.9",
    aum: "$480M",
    experience: "14 yrs",
    registration: "SEBI Registered - INA000284913",
    certifications: ["CFP", "NISM X-A"],
    about:
      "Fee-only planner focused on concentrated equity and tax-aware rebalancing. Strong fit for tech professionals with taxable gains.",
  },
  {
    id: "do",
    kind: "advisors",
    name: "David Okafor",
    credential: "CFA",
    role: "Advisor",
    firm: "Northlight Advisors",
    initials: "DO",
    tone: "teal",
    summary: "Balances stocks and bonds",
    meta: "Balances stocks and bonds - 0.75% - 4.8",
    fee: "0.75%",
    monthly: "~$89/mo for you",
    rating: "4.8",
    aum: "$1.2B",
    experience: "11 yrs",
    registration: "SEBI Registered - INA000301177",
    certifications: ["CFA", "NISM X-B"],
    about:
      "Portfolio strategist for multi-asset households. Fiduciary, performance-reporting first, and strongest when goals span several accounts.",
  },
  {
    id: "ps",
    kind: "advisors",
    name: "Priya Sharma",
    credential: "CFP",
    role: "Advisor",
    firm: "Crestview Capital",
    initials: "PS",
    tone: "orange",
    summary: "Plans for life goals",
    meta: "Plans for life goals - 0.55% - 4.9",
    fee: "0.55%",
    monthly: "~$65/mo for you",
    rating: "4.9",
    aum: "$310M",
    experience: "9 yrs",
    registration: "SEBI Registered - INA000322054",
    certifications: ["CFP", "NISM X-A"],
    about:
      "Goals-based planner for families and long-term milestones. Fee-only, no commissions, with quarterly reviews.",
  },
  {
    id: "en",
    kind: "advisors",
    name: "Emily Nakamura",
    credential: "CFA",
    role: "Advisor",
    firm: "Bluestone Wealth",
    initials: "EN",
    tone: "blue",
    summary: "Reduces single-stock risk",
    meta: "Reduces single-stock risk - 0.65% - 4.8",
    fee: "0.65%",
    monthly: "~$77/mo for you",
    rating: "4.8",
    aum: "$920M",
    experience: "12 yrs",
    registration: "SEBI Registered - INA000275660",
    certifications: ["CFA", "FRM"],
    about:
      "Risk-first portfolio construction. Specialises in single-stock concentration exits and staged rebalancing plans.",
  },
  {
    id: "hp",
    kind: "firms",
    name: "Harbor Point Advisors",
    credential: "RIA",
    role: "Firm",
    firm: "12 advisors",
    initials: "HP",
    tone: "purple",
    summary: "Retirement and estate",
    meta: "Retirement and estate - 0.70% - 4.7",
    fee: "0.70%",
    monthly: "~$83/mo for you",
    rating: "4.7",
    aum: "$750M",
    experience: "18 yrs",
    registration: "SEBI Registered firm - INA000156208",
    certifications: ["Corporate RIA", "12 IARs"],
    about:
      "Independent fiduciary firm for retirement and estate planning. Team-based coverage, no single point of failure.",
  },
  {
    id: "bw",
    kind: "firms",
    name: "Bluestone Wealth",
    credential: "RIA",
    role: "Firm",
    firm: "9 advisors",
    initials: "BW",
    tone: "teal",
    summary: "Risk-first portfolios",
    meta: "Risk-first portfolios - 0.68% - 4.8",
    fee: "0.68%",
    monthly: "~$81/mo for you",
    rating: "4.8",
    aum: "$920M",
    experience: "15 yrs",
    registration: "SEBI Registered firm - INA000198440",
    certifications: ["Corporate RIA", "9 IARs"],
    about:
      "Independent risk-first firm. Team coverage across planning, portfolios, and concentrated positions.",
  },
];

const CONNECT_PICK =
  CONNECT_PROFILES.find((profile) => profile.id === "en") ?? CONNECT_PROFILES[3]!;

const connectRootClassName = cn(
  marketSurfaceVariablesClassName,
  "relative isolate mx-auto flex min-h-screen w-full !max-w-none flex-col overflow-x-hidden !px-0 pb-0",
  "bg-[color:var(--one-bg)] font-sans text-[color:var(--one-fg)] antialiased",
  "[--one-bg:#ffffff] [--one-card:#ffffff] [--one-surface:#f2f2f7]",
  "dark:[--one-bg:#000000] dark:[--one-card:#1c1c1e] dark:[--one-surface:#1c1c1e]",
  "[--one-hairline:rgba(0,0,0,0.08)] [--one-line:rgba(0,0,0,0.06)]",
  "dark:[--one-hairline:rgba(255,255,255,0.14)] dark:[--one-line:rgba(255,255,255,0.10)]",
  "[--one-fg:#1d1d1f] [--one-fg2:rgba(0,0,0,0.55)] [--one-fg3:rgba(0,0,0,0.42)]",
  "dark:[--one-fg:#f5f5f7] dark:[--one-fg2:rgba(245,245,247,0.64)] dark:[--one-fg3:rgba(245,245,247,0.46)]",
  "[--one-blue:#0071e3] [--one-link:#0066cc] [--one-blue-t:rgba(0,113,227,0.10)]",
  "dark:[--one-blue:#0a84ff] dark:[--one-link:#2997ff] dark:[--one-blue-t:rgba(10,132,255,0.18)]",
  "[--one-up:#34c759] [--one-up-t:rgba(52,199,89,0.12)]",
  "[--one-down:#ff3b30] [--one-down-t:rgba(255,59,48,0.10)]",
  "[--one-indigo:#5856d6] [--one-indigo-t:rgba(88,86,214,0.12)]",
  "[--one-orange:#ff9500] [--one-orange-t:rgba(255,149,0,0.14)]",
  "[--one-teal:#30b0c7] [--one-teal-t:rgba(48,176,199,0.13)]",
  "[--one-purple:#af52de] [--one-purple-t:rgba(175,82,222,0.12)]",
  "[--one-glass-fill:linear-gradient(135deg,rgba(255,255,255,0.45),rgba(255,255,255,0.16))]",
  "dark:[--one-glass-fill:linear-gradient(135deg,rgba(44,44,46,0.86),rgba(28,28,30,0.62))]",
  "[--one-glass-float:0_16px_38px_-20px_rgba(0,0,0,0.28),0_4px_12px_-8px_rgba(0,0,0,0.10)]",
  "[--one-gutter:clamp(18px,5vw,32px)]"
);

const connectGlassClassName = cn(
  "relative bg-[image:var(--one-glass-fill)] backdrop-blur-[20px] backdrop-saturate-[200%]",
  "shadow-[var(--one-glass-float),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_1px_rgba(0,0,0,0.06)]",
  "ring-1 ring-white/55"
);

function openConnectHref(href: string) {
  requestInternalAppNavigation({ href, scroll: false });
}

function toneClassName(tone: ConnectTone): string {
  if (tone === "teal") return "bg-[color:var(--one-teal-t)] text-[color:var(--one-teal)]";
  if (tone === "orange") return "bg-[color:var(--one-orange-t)] text-[color:var(--one-orange)]";
  if (tone === "purple") return "bg-[color:var(--one-purple-t)] text-[color:var(--one-purple)]";
  if (tone === "blue") return "bg-[color:var(--one-blue-t)] text-[color:var(--one-link)]";
  return "bg-[color:var(--one-indigo-t)] text-[color:var(--one-indigo)]";
}

function AdvisorAvatar({
  profile,
  className,
}: {
  profile: AdvisorProfile;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid h-11 w-11 shrink-0 place-items-center rounded-full text-[15px] font-bold",
        toneClassName(profile.tone),
        className
      )}
      aria-hidden="true"
    >
      {profile.kind === "firms" ? <Building2 className="h-5 w-5" /> : profile.initials}
    </span>
  );
}

function SectionHeader({
  title,
  icon: Icon,
  tone,
  action,
}: {
  title: string;
  icon: LucideIcon;
  tone: "blue" | "teal";
  action?: ReactNode;
}) {
  const toneClass =
    tone === "blue"
      ? "bg-[color:var(--one-blue-t)] text-[color:var(--one-link)]"
      : "bg-[color:var(--one-teal-t)] text-[color:var(--one-teal)]";

  return (
    <div className="mb-3.5 flex items-center justify-between gap-3">
      <div className={kaiPreviewSectionTitleClassName} role="heading" aria-level={2}>
        <span className={cn("grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg", toneClass)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
      {action}
    </div>
  );
}

function AdvisorRow({
  profile,
  onOpen,
}: {
  profile: AdvisorProfile;
  onOpen: (profile: AdvisorProfile) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(profile)}
      className="flex w-full items-center gap-3 border-t border-[color:var(--one-line)] px-[15px] py-3.5 text-left transition-colors first:border-t-0 active:bg-[color:var(--one-surface)]"
    >
      <AdvisorAvatar profile={profile} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold leading-tight text-[color:var(--one-fg)]">
            {profile.name}
          </span>
          <span className="shrink-0 text-[12px] font-medium text-[color:var(--one-fg3)]">
            {profile.credential}
          </span>
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[color:var(--one-up)]" />
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-[color:var(--one-fg2)]">
          {profile.role} - {profile.firm}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[12px] text-[color:var(--one-fg3)]">
          <span className="truncate">{profile.summary} - {profile.fee}</span>
          <Star className="h-3 w-3 shrink-0 fill-[color:var(--one-orange)] text-[color:var(--one-orange)]" />
          <span className="shrink-0">{profile.rating}</span>
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--one-fg3)]" />
    </button>
  );
}

function ConnectDock({
  searchQuery,
  onSearchQueryChange,
  onKaiOpen,
}: {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onKaiOpen: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState(searchQuery);
  const items: Array<{ label: string; href: string; icon: LucideIcon; active?: boolean }> = [
    { label: "Market", href: "/kai?preview=market", icon: Store },
    { label: "Portfolio", href: "/kai/portfolio", icon: WalletCards },
    { label: "Analysis", href: "/kai/analysis?preview=analysis", icon: LineChart },
    { label: "Connect", href: "/kai?preview=connect", icon: Compass, active: true },
    { label: "Profile", href: "/profile", icon: UserRound },
  ];

  const submitSearch = () => {
    onSearchQueryChange(draft.trim());
    setSearchOpen(false);
  };

  return (
    <div className={kaiPreviewDockFrameClassName}>
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
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
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
              onClick={() => {
                setSearchOpen(false);
                setDraft(searchQuery);
              }}
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
                    onClick={() => openConnectHref(item.href)}
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
                onClick={() => {
                  setDraft(searchQuery);
                  setSearchOpen(true);
                }}
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
    "I compared all five against your portfolio. Emily Nakamura is your strongest match - your Tesla concentration is exactly her specialty, and her SEBI registration checks out.",
  ]);
  const [draft, setDraft] = useState("");

  const ask = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    const reply = lower.includes("fiduciary")
      ? "A fiduciary is legally bound to act in your best interest, and fee-only means no commissions. Every advisor here meets that bar."
      : lower.includes("see") || lower.includes("data")
        ? "Only what you approve. When you connect, you choose the scopes, every share gets a signed receipt, and you can revoke access any time."
        : "Emily is the best match because Tesla is 31% of your portfolio, and reducing single-stock concentration is her specialty.";
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
        {["Why Emily for me?", "What's a fiduciary?", "What will they see?"].map((question) => (
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
          { title: "Registration verified", body: "SEBI network check completed", time: "2m", tone: "up" },
          { title: "Kai pick ready", body: "Emily Nakamura - 94% match", time: "1h", tone: "blue" },
          { title: "Consent receipt saved", body: "No advisor data shared yet", time: "3h", tone: "neutral" },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-3 border-t border-[color:var(--one-line)] px-4 py-3 first:border-t-0">
            <span
              className={cn(
                "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
                item.tone === "up" && "bg-[color:var(--one-up-t)] text-[color:var(--one-up)]",
                item.tone === "blue" && "bg-[color:var(--one-blue-t)] text-[color:var(--one-link)]",
                item.tone === "neutral" && "bg-[color:var(--one-surface)] text-[color:var(--one-fg3)]"
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

function AdvisorDetailSheet({
  profile,
  requested,
  onClose,
  onConnect,
}: {
  profile: AdvisorProfile | null;
  requested: boolean;
  onClose: () => void;
  onConnect: (profile: AdvisorProfile) => void;
}) {
  if (!profile) return null;

  return (
    <section className="fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[88vh] max-w-[440px] flex-col rounded-t-[28px] bg-[#f9f9fb]/95 shadow-[0_-18px_50px_-20px_rgba(0,0,0,0.40)] backdrop-blur-[22px] backdrop-saturate-[180%]">
      <div className="mx-auto mt-[9px] h-[5px] w-9 rounded-full bg-[color:var(--one-fg3)]/35" />
      <header className="flex items-center gap-[11px] border-b border-[color:var(--one-line)] px-[18px] pb-3 pt-3">
        <AdvisorAvatar profile={profile} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[17px] font-semibold text-[color:var(--one-fg)]">{profile.name}</b>
          <span className="block truncate text-[12px] text-[color:var(--one-fg3)]">
            {profile.role} - {profile.firm}
          </span>
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
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        <div className="grid grid-cols-3 gap-2.5">
          {[
            { label: "Manages", value: profile.aum },
            { label: "Rating", value: profile.rating },
            { label: "Experience", value: profile.experience },
          ].map((item) => (
            <div key={item.label} className="rounded-[14px] border border-[color:var(--one-hairline)] px-3 py-2.5">
              <p className="text-[11px] font-medium text-[color:var(--one-fg3)]">{item.label}</p>
              <p className="mt-1 text-[15px] font-semibold text-[color:var(--one-fg)] tabular-nums">{item.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-3.5 text-[14px] leading-snug text-[color:var(--one-fg2)]">
          {profile.about}
        </p>

        <h3 className="mt-4 text-[13px] font-semibold text-[color:var(--one-fg)]">
          What they will see - you approve each scope
        </h3>
        <div className="mt-2.5 flex flex-col gap-2">
          {[
            { label: "Holdings and allocation", ok: true },
            { label: "Risk profile and goals", ok: true },
            { label: "Transactions - not shared", ok: false },
          ].map((scope) => (
            <div
              key={scope.label}
              className={cn(
                "flex items-center gap-2 rounded-xl bg-[color:var(--one-surface)] px-3 py-2.5 text-[13px] font-medium",
                !scope.ok && "text-[color:var(--one-fg3)]"
              )}
            >
              {scope.ok ? (
                <Check className="h-3.5 w-3.5 text-[color:var(--one-up)]" />
              ) : (
                <Minus className="h-3.5 w-3.5 text-[color:var(--one-fg3)]" />
              )}
              {scope.label}
            </div>
          ))}
        </div>

        <h3 className="mt-4 text-[13px] font-semibold text-[color:var(--one-fg)]">
          Registration and certifications
        </h3>
        <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-[color:var(--one-up-t)] px-3 py-2.5 text-[13px] font-medium text-[color:var(--one-fg)]">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[color:var(--one-up)]" />
          <span className="min-w-0 flex-1 truncate">{profile.registration}</span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-[color:var(--one-up)]">
            Verified
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {profile.certifications.map((certification) => (
            <span
              key={certification}
              className="rounded-full bg-[color:var(--one-surface)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--one-fg2)]"
            >
              {certification}
            </span>
          ))}
        </div>

        <h3 className="mt-4 text-[13px] font-semibold text-[color:var(--one-fg)]">Advisory fee</h3>
        <div className="mt-2.5 rounded-2xl border border-[color:var(--one-hairline)] px-4 py-3.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[28px] font-semibold leading-none text-[color:var(--one-fg)]">{profile.fee}</span>
            <span className="text-[13px] text-[color:var(--one-fg3)]">per year</span>
            <span className="ml-auto rounded-full bg-[color:var(--one-blue-t)] px-2.5 py-1 text-[12px] font-semibold text-[color:var(--one-link)]">
              {profile.monthly}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {["Quarterly reviews", "Rebalancing plan", "Direct chat"].map((item) => (
              <span key={item} className="inline-flex items-center gap-1.5 text-[13px] font-medium">
                <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--one-up)]" />
                {item}
              </span>
            ))}
          </div>
          <p className="mt-3 text-[12px] leading-snug text-[color:var(--one-fg3)]">
            No commissions. Billed quarterly by the advisor - never through Kai.
          </p>
        </div>
      </div>
      <div className="border-t border-[color:var(--one-line)] px-[18px] pb-[calc(16px+env(safe-area-inset-bottom))] pt-3">
        <button
          type="button"
          onClick={() => onConnect(profile)}
          className={cn(
            "w-full rounded-full px-4 py-3.5 text-[15px] font-semibold transition-transform active:scale-[0.98]",
            requested
              ? "bg-[color:var(--one-up-t)] text-[color:var(--one-up)]"
              : "bg-[color:var(--one-blue)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.30)]"
          )}
        >
          {requested ? "Requested" : "Connect"}
        </button>
        {requested ? (
          <p className="mt-2.5 text-center text-[12px] leading-snug text-[color:var(--one-fg2)]">
            They will reach out within a day. Nothing is shared until you approve their request.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function KaiConnectPreviewView() {
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("advisors");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<AdvisorProfile | null>(null);
  const [requestedIds, setRequestedIds] = useState<Set<string>>(() => new Set());
  const [kaiOpen, setKaiOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const visibleProfiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const baseRows = CONNECT_PROFILES.filter((profile) => profile.kind === directoryMode);
    if (!query) return baseRows;
    return baseRows.filter((profile) =>
      [profile.name, profile.firm, profile.summary, profile.registration, profile.certifications.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [directoryMode, searchQuery]);

  const overlayOpen = kaiOpen || notificationsOpen || Boolean(selectedProfile);

  return (
    <AppPageShell
      as="div"
      width="reading"
      className={connectRootClassName}
      data-one-connect-preview="true"
    >
      <style>
        {`
          html:has([data-one-connect-preview="true"]),
          body {
            background: #ffffff !important;
          }

          body:has([data-one-connect-preview="true"]) main,
          body:has([data-one-connect-preview="true"]) [data-top-content-anchor="true"],
          body:has([data-one-connect-preview="true"]) [class*="overflow-y-auto"][class*="touch-pan-y"] {
            background: #ffffff !important;
          }

          html.dark:has([data-one-connect-preview="true"]),
          html.dark:has([data-one-connect-preview="true"]) body,
          html.dark:has([data-one-connect-preview="true"]) body main,
          html.dark:has([data-one-connect-preview="true"]) body [data-top-content-anchor="true"],
          html.dark:has([data-one-connect-preview="true"]) body [class*="overflow-y-auto"][class*="touch-pan-y"] {
            background: #000000 !important;
          }

          nextjs-portal,
          [aria-label="Open consent inbox"] {
            display: none !important;
          }
        `}
      </style>
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-20 bg-[color:var(--one-bg)]" />

      <div className="mx-auto flex min-h-screen w-full max-w-[1080px] flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto px-[var(--one-gutter)] pb-[calc(190px+env(safe-area-inset-bottom))] pt-5 sm:pt-7">
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className={cn(kaiPreviewEyebrowClassName, "text-[color:var(--one-fg3)]")}>
                SEBI-registered network
              </span>
              <div className={cn("mt-1.5", kaiPreviewPageTitleClassName)} role="heading" aria-level={1}>
                Connect
              </div>
              <p className="mt-2 max-w-[34ch] text-[17px] leading-[1.42] text-[color:var(--one-fg2)]">
                Find a registered advisor. Connect with consent.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setNotificationsOpen(true)}
              className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--one-surface)] text-[color:var(--one-fg)] transition-transform active:scale-90"
              aria-label="Notifications"
            >
              <span className="absolute right-2 top-[7px] h-1.5 w-1.5 rounded-full bg-[color:var(--one-down,#ff3b30)] shadow-[0_0_0_2px_var(--one-surface)]" />
              <Bell className="h-[17px] w-[17px]" />
            </button>
          </header>

          <form
            onSubmit={(event) => event.preventDefault()}
            className="mt-5 flex h-12 items-center gap-2.5 rounded-[16px] bg-[color:var(--one-surface)] px-4"
          >
            <Search className="h-[17px] w-[17px] shrink-0 text-[color:var(--one-fg3)]" />
            <input
              type="text"
              placeholder="Search advisors"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--one-fg)] outline-none placeholder:text-[color:var(--one-fg3)]"
            />
          </form>

          <button
            type="button"
            onClick={() => setKaiOpen(true)}
            className={cn(connectGlassClassName, "mt-4 flex w-full items-center gap-[11px] rounded-2xl px-3.5 py-3 text-left transition-transform active:scale-[0.99]")}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white">
              <MessageCircle className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 text-[13px] leading-snug text-[color:var(--one-fg)]">
              <b className="font-semibold">Kai:</b> I compared all five against your portfolio - ask me why Emily fits best.
            </span>
            <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[color:var(--one-fg3)]" />
          </button>

          <section className="mt-8">
            <SectionHeader
              title="Kai's pick for you"
              icon={Star}
              tone="blue"
              action={
                <span className="shrink-0 rounded-full bg-[color:var(--one-up-t)] px-2.5 py-1 text-[12px] font-semibold text-[color:var(--one-up)]">
                  94% match
                </span>
              }
            />
            <div className="rounded-[20px] border border-[rgba(0,113,227,0.30)] bg-[color:var(--one-card)] p-4 shadow-[0_10px_30px_-22px_rgba(0,113,227,0.45)]">
              <div className="flex items-center gap-3">
                <AdvisorAvatar profile={CONNECT_PICK} className="h-[54px] w-[54px] text-[17px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-[color:var(--one-fg)]">
                    {CONNECT_PICK.name} <small className="font-medium text-[color:var(--one-fg3)]">{CONNECT_PICK.credential}</small>
                  </span>
                  <span className="block truncate text-[12px] text-[color:var(--one-fg2)]">
                    {CONNECT_PICK.role} - {CONNECT_PICK.firm}
                  </span>
                </span>
              </div>
              <p className="mt-3 text-[14px] leading-snug text-[color:var(--one-fg2)]">
                Tesla is 31% of your portfolio - your biggest risk. Emily&apos;s specialty is exactly this: safely reducing one oversized stock.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {["SEBI - INA000275660", "CFA - FRM", "Single-stock risk expert"].map((item) => (
                  <span
                    key={item}
                    className="rounded-full bg-[color:var(--one-surface)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--one-fg2)]"
                  >
                    {item}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSelectedProfile(CONNECT_PICK)}
                className="mt-3.5 w-full rounded-full bg-[color:var(--one-surface)] py-3 text-[14px] font-semibold text-[color:var(--one-link)] transition-transform active:scale-[0.98]"
              >
                View profile
              </button>
            </div>
          </section>

          <section className="mt-8">
            <SectionHeader title="Registered advisors" icon={UsersRound} tone="teal" />
            <div className="mb-3.5 grid grid-cols-2 rounded-xl bg-[color:var(--one-surface)] p-[3px]">
              {[
                { id: "advisors" as const, label: "Advisors" },
                { id: "firms" as const, label: "Firms" },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setDirectoryMode(item.id);
                    if (searchQuery.trim()) setSearchQuery("");
                  }}
                  aria-pressed={directoryMode === item.id}
                  className={cn(
                    "rounded-[10px] px-2 py-2 text-[13px] font-semibold text-[color:var(--one-fg2)] transition-colors",
                    directoryMode === item.id &&
                      "bg-[color:var(--one-card)] text-[color:var(--one-fg)] shadow-[0_1px_4px_rgba(0,0,0,0.14)]"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="overflow-hidden rounded-[20px] bg-[color:var(--one-card)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              {visibleProfiles.map((profile) => (
                <AdvisorRow key={profile.id} profile={profile} onOpen={setSelectedProfile} />
              ))}
              {visibleProfiles.length === 0 ? (
                <div className="px-4 py-8 text-center text-[14px] text-[color:var(--one-fg2)]">
                  No registered advisors match this search.
                </div>
              ) : null}
            </div>
            <div className="mt-3.5 flex items-start gap-2.5 px-1">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--one-fg3)]" />
              <p className="text-center text-[12px] leading-snug text-[color:var(--one-fg3)]">
                Every advisor on One is SEBI-registered, fee-only and a fiduciary. They see only what you approve; every share is receipted.
              </p>
            </div>
          </section>
        </main>

        <ConnectDock
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onKaiOpen={() => setKaiOpen(true)}
        />
      </div>

      {overlayOpen ? (
        <button
          type="button"
          aria-label="Close overlay"
          className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[6px]"
          onClick={() => {
            setSelectedProfile(null);
            setKaiOpen(false);
            setNotificationsOpen(false);
          }}
        />
      ) : null}
      <AdvisorDetailSheet
        profile={selectedProfile}
        requested={Boolean(selectedProfile && requestedIds.has(selectedProfile.id))}
        onClose={() => setSelectedProfile(null)}
        onConnect={(profile) => {
          setRequestedIds((current) => new Set([...current, profile.id]));
        }}
      />
      <KaiSheet open={kaiOpen} onClose={() => setKaiOpen(false)} />
      <NotificationsSheet open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    </AppPageShell>
  );
}
