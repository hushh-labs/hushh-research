"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Cloud,
  RefreshCw,
  ShieldCheck,
  Upload,
} from "@/components/icons";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import {
  OneStreamEventCard,
  type OneStreamEventItem,
} from "@/components/agent/specialist-directive-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type PreviewFrameWidth = "full" | "drawer" | "mobile";
type PreviewSurfaceTheme = "system" | "light" | "dark";

const SAMPLE_HOLDINGS_MARKDOWN = `### Shared Brokerage Holdings · Kushal Trivedi

| Ticker | Holding | Shares | Price | Market Value | Day |
| :--- | :--- | ---: | ---: | ---: | ---: |
| NVDA | NVIDIA Corp. | 185 | $142.80 | $26,418.00 | +2.14% |
| AAPL | Apple Inc. | 110 | $229.40 | $25,234.00 | +0.68% |
| VOO | Vanguard S&P 500 ETF | 42 | $549.25 | $23,068.50 | +0.41% |
| SPAXX | Fidelity Gov Money Market | 1,618.5 | $1.00 | $1,618.50 | 0.00% |

*Source: Plaid Investments live holdings projection · Decrypted on this device only.*`;

const STREAM_SPECIMENS: OneStreamEventItem[] = [
  {
    id: "spec-shared-portfolio",
    eventKind: "shared_access_unlocked",
    actorLabel: "Kushal Trivedi",
    headline: "Kushal Trivedi shared access",
    detail: "Financial · Investment Portfolio · 7 days · Decrypted on this device",
    href: "/one/consent?tab=active",
    status: "pending",
  },
  {
    id: "spec-settlement",
    eventKind: "commerce_settlement",
    actorLabel: "One",
    headline: "Payment settlement update",
    detail: "500 Hussh coins ($5.00) reserved for Kushal Trivedi · Portfolio",
    href: "/one/feed",
    status: "pending",
  },
  {
    id: "spec-connection",
    eventKind: "incoming_connection",
    actorLabel: "Ankit Kumar Singh",
    headline: "Ankit Kumar Singh wants to connect",
    detail: "Direct encrypted sharing · Ask first by default",
    href: "/one/connect",
    status: "pending",
  },
];

function SpecimenSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" data-testid={`storybook-section-${eyebrow.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {eyebrow}
        </p>
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-foreground">
          {title}
        </h2>
        <p className="text-[13px] leading-[19px] text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

export function ReferenceStorybook() {
  const [frameWidth, setFrameWidth] = useState<PreviewFrameWidth>("full");
  const [surfaceTheme, setSurfaceTheme] = useState<PreviewSurfaceTheme>("system");
  const [autoSave, setAutoSave] = useState(true);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const frameClass =
    frameWidth === "mobile"
      ? "mx-auto w-full max-w-[360px]"
      : frameWidth === "drawer"
        ? "mx-auto w-full max-w-[370px]"
        : "w-full";

  const surfaceThemeClass =
    surfaceTheme === "dark"
      ? "dark rounded-2xl border border-white/[0.09] bg-[#0e0e10] p-4 text-[#f5f5f7] sm:p-5"
      : surfaceTheme === "light"
        ? "light rounded-2xl border border-black/[0.08] bg-[#f7f7f9] p-4 text-[#111114] sm:p-5"
        : "rounded-2xl border border-black/[0.07] bg-muted/20 p-4 dark:border-white/[0.08] sm:p-5";

  return (
    <AppPageShell
      as="main"
      width="standard"
      fitContent
      data-testid="reference-design-storybook-page"
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Reference Design System"
          description="Apple Private Cloud + Linear/Geist craft specimens. Inspect button density, top-bar progressive blur fade, Sandbox telemetry, Chat cards, and financial tables at every breakpoint."
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div className="space-y-8 pb-16">
          {/* Interactive founder sign-off toolbar */}
          <div
            data-testid="storybook-controls-bar"
            className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-black/[0.08] bg-[color:var(--app-card-surface-default-solid)] px-3.5 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/[0.09] dark:shadow-none"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11.5px] font-medium text-muted-foreground">
                Viewport
              </span>
              {(
                [
                  { id: "full", label: "Full width" },
                  { id: "drawer", label: "370px drawer" },
                  { id: "mobile", label: "360px phone" },
                ] as const
              ).map((opt) => (
                <Button
                  key={opt.id}
                  size="xs"
                  variant={frameWidth === opt.id ? "default" : "outline"}
                  onClick={() => setFrameWidth(opt.id)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11.5px] font-medium text-muted-foreground">
                Surface
              </span>
              {(
                [
                  { id: "system", label: "System" },
                  { id: "light", label: "Light" },
                  { id: "dark", label: "Dark" },
                ] as const
              ).map((opt) => (
                <Button
                  key={opt.id}
                  size="xs"
                  variant={surfaceTheme === opt.id ? "default" : "outline"}
                  onClick={() => setSurfaceTheme(opt.id)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          {lastAction ? (
            <div
              role="status"
              className="rounded-xl border border-black/[0.08] bg-[color:var(--app-card-surface-default-solid)] px-3.5 py-2 text-xs text-muted-foreground dark:border-white/[0.09]"
            >
              Interactive check: <span className="font-medium text-foreground">{lastAction}</span>
            </div>
          ) : null}

          <div className={cn("space-y-10", frameClass, surfaceThemeClass)}>
            {/* Specimen 1: Global Button Density & Hairline Geometry */}
            <SpecimenSection
              eyebrow="01 · Controls & Density"
              title="Sleek Global Button Scale & Toolbar Alignment"
              description="Default controls sit at 36px, toolbars and inline card actions at 32px, and primary flow commits at 40px with crisp hairline borders. Pills stay reserved for tiny row chips."
            >
              <div className="space-y-4 rounded-[14px] border border-black/[0.08] bg-[color:var(--app-card-surface-default-solid)] p-4 dark:border-white/[0.09]">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="xs" variant="outline" onClick={() => setLastAction("xs (28px)")}>
                    XS · 28px
                  </Button>
                  <Button size="compact" variant="outline" onClick={() => setLastAction("compact (32px)")}>
                    Compact · 32px
                  </Button>
                  <Button size="standard" variant="secondary" onClick={() => setLastAction("standard (36px)")}>
                    Standard · 36px
                  </Button>
                  <Button size="default" onClick={() => setLastAction("default primary (36px)")}>
                    Primary · 36px
                  </Button>
                  <Button size="prominent" onClick={() => setLastAction("prominent commit (40px)")}>
                    Prominent · 40px
                  </Button>
                  <Button size="row" variant="secondary" onClick={() => setLastAction("row pill (28px)")}>
                    Row pill · 28px
                  </Button>
                  <Button size="compact" variant="destructive" onClick={() => setLastAction("destructive (32px)")}>
                    Disconnect
                  </Button>
                </div>

                {/* Real Files Toolbar Specimen */}
                <div className="space-y-2 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.07]">
                  <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    Files & Personal Wiki Toolbar Specimen
                  </p>
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-black/[0.07] bg-muted/25 px-3 py-2 dark:border-white/[0.08]">
                    <Input
                      readOnly
                      value=""
                      placeholder="Quick open or filter .md file"
                      className="h-8 min-w-[160px] flex-1 rounded-[9px] text-[12.5px]"
                    />
                    <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <span>Auto-save</span>
                      <Switch checked={autoSave} onCheckedChange={setAutoSave} />
                    </label>
                    <Button size="compact" variant="outline" onClick={() => setLastAction("Optimize memory")}>
                      <RefreshCw className="size-3.5" aria-hidden="true" />
                      Optimize memory
                    </Button>
                    <Button size="compact" variant="outline" onClick={() => setLastAction("Import archive")}>
                      <Upload className="size-3.5" aria-hidden="true" />
                      Import archive
                    </Button>
                    <Button size="compact" onClick={() => setLastAction("Upload file")}>
                      <Upload className="size-3.5" aria-hidden="true" />
                      Upload
                    </Button>
                  </div>
                </div>

                {/* Real Agent Updates Footer Specimen */}
                <div className="space-y-2 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.07]">
                  <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    Agent Updates Action Specimen
                  </p>
                  <SettingsGroup separatorInset>
                    <SettingsRow title="Status" description="Managed automatically" />
                    <SettingsRow
                      title="Current version"
                      description="Confidential Sandbox · Latest"
                      chevron
                    />
                  </SettingsGroup>
                  <div className="pt-1">
                    <Button size="compact" variant="secondary" onClick={() => setLastAction("Check for updates")}>
                      Check for updates
                    </Button>
                  </div>
                </div>
              </div>
            </SpecimenSection>

            {/* Specimen 2: Unified Top App Bar Progressive Blur Mask Fade */}
            <SpecimenSection
              eyebrow="02 · Top App Bar Chrome"
              title="Universal Raised-Cosine Progressive Mask Fade"
              description="Matches Agent Chat's signature progressive blur and raised-cosine dissolve across every screen (Files, Connect, One, Feed, Profile). Scroll inside this preview or scroll this page to inspect the fade."
            >
              <div className="relative h-48 overflow-y-auto rounded-[14px] border border-black/[0.08] bg-[color:var(--app-layout-surface,var(--background))] dark:border-white/[0.09]">
                <div
                  className="sticky top-0 z-10 flex h-12 items-center justify-between px-4"
                  style={{
                    background:
                      "linear-gradient(to bottom, color-mix(in srgb, var(--background) 92%, transparent) 0%, color-mix(in srgb, var(--background) 78%, transparent) 55%, color-mix(in srgb, var(--background) 32%, transparent) 82%, transparent 100%)",
                    backdropFilter: "blur(20px) saturate(180%)",
                    WebkitBackdropFilter: "blur(20px) saturate(180%)",
                  }}
                >
                  <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                    Files · Personal wiki
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-black/[0.08] bg-background/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground dark:border-white/[0.1]">
                    Progressive fade
                  </span>
                </div>
                <div className="space-y-2 px-4 pb-5 pt-1">
                  {[
                    "ai-tooling-local-hardware-and-partnerships.md · Updated Nov 24",
                    "portfolio-rebalance-notes.md · Encrypted vault note",
                    "schwab-brokerage-statement-2026-11.pdf · Sealed delivery",
                    "plaid-investments-projection.json · Live scope snapshot",
                    "consent-receipt-kushal-portfolio-500-coins.json · Settled",
                  ].map((item) => (
                    <div
                      key={item}
                      className="rounded-xl border border-black/[0.07] bg-[color:var(--app-card-surface-default-solid)] px-3.5 py-2.5 text-[12.5px] text-foreground dark:border-white/[0.08]"
                    >
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </SpecimenSection>

            {/* Specimen 3: Living Confidential Sandbox Hero Card */}
            <SpecimenSection
              eyebrow="03 · Compute & Custody"
              title="Living Confidential Sandbox Hero Card"
              description="Zero-truncation hosting tier identity, living presence beacon, cloud provenance pill, integrated footer action, and zero duplicate option beneath Switch hosting."
            >
              <div className="space-y-3">
                <div className="overflow-hidden rounded-2xl border border-black/[0.08] bg-gradient-to-b from-foreground/[0.028] to-transparent dark:border-white/[0.09] dark:from-white/[0.045]">
                  <div className="flex items-start gap-3.5 p-4">
                    <span className="relative grid size-10 shrink-0 place-items-center rounded-xl border border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-600 dark:border-emerald-400/25 dark:bg-emerald-400/[0.12] dark:text-emerald-400">
                      <ShieldCheck className="size-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          Current hosting
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/[0.1] px-2.5 py-0.5 text-[11.5px] font-medium text-emerald-700 dark:text-emerald-300">
                          <span className="relative flex size-2">
                            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
                            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                          </span>
                          Connected
                        </span>
                      </div>
                      <p className="text-[16px] font-semibold leading-[22px] tracking-[-0.015em] text-foreground">
                        Hussh Confidential Sandbox
                      </p>
                      <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                        Isolated memory · Auto-sleep · Built-in AI
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] bg-foreground/[0.015] px-4 py-2.5 dark:border-white/[0.07]">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-background/70 px-2.5 py-0.5 text-[11.5px] font-medium text-muted-foreground dark:border-white/[0.1]">
                      <Cloud className="size-3.5" aria-hidden="true" />
                      Google Cloud
                    </span>
                    <button
                      type="button"
                      onClick={() => setLastAction("Check hosting")}
                      className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--app-accent)] hover:underline"
                    >
                      Check hosting
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            </SpecimenSection>

            {/* Specimen 4: Redesigned Chat Stream Event Cards */}
            <SpecimenSection
              eyebrow="04 · Chat Activity & Sharing"
              title="Compact Tactile Shared-Access & Settlement Cards"
              description="Replaces blank-void placeholder cards with real sender identity, semantic encrypted badges, scope details, and inline 32px actions."
            >
              <div className="space-y-2.5">
                {STREAM_SPECIMENS.map((specimen) => (
                  <OneStreamEventCard
                    key={specimen.id}
                    item={specimen}
                    onOpen={(item) => setLastAction(`Opened ${item.headline}`)}
                    onAccept={(item) => setLastAction(`Accepted ${item.actorLabel}`)}
                    onDecline={(item) => setLastAction(`Declined ${item.actorLabel}`)}
                  />
                ))}
              </div>
            </SpecimenSection>

            {/* Specimen 5: Plaid Metric Strip & Financial Markdown Table */}
            <SpecimenSection
              eyebrow="05 · Financial & Paid Scopes"
              title="Tabular Metric Strip & Brokerage Holdings Table"
              description="Three-column tabular-numeral summary paired with right-aligned financial markdown tables so numeric columns scan effortlessly."
            >
              <div className="space-y-4">
                <div className="rounded-[14px] border border-black/[0.08] bg-[color:var(--app-card-surface-default-solid)] p-3.5 dark:border-white/[0.09]">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Account summary
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                      <RefreshCw className="size-3 text-[color:var(--app-accent)]" aria-hidden="true" />
                      Updates on sync
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "Net worth", value: "-$231,492" },
                      { label: "Liquid cash", value: "$184,767" },
                      { label: "Investable", value: "$71,858" },
                    ].map((metric) => (
                      <div
                        key={metric.label}
                        className="rounded-xl border border-black/[0.06] bg-muted/25 px-3 py-2.5 dark:border-white/[0.07]"
                      >
                        <p className="text-[11px] text-muted-foreground">{metric.label}</p>
                        <p className="mt-0.5 text-[14.5px] font-semibold tabular-nums tracking-[-0.015em] text-foreground">
                          {metric.value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[14px] border border-black/[0.08] bg-[color:var(--app-card-surface-default-solid)] p-4 dark:border-white/[0.09]">
                  <AgentMarkdown text={SAMPLE_HOLDINGS_MARKDOWN} />
                </div>
              </div>
            </SpecimenSection>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
