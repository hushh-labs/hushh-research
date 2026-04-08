"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  Crown,
  Download,
  FileSpreadsheet,
  Loader2,
  Medal,
  PencilLine,
  Plus,
  Save,
  Star,
  Trash2,
  Trophy,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import {
  CommandPickerField,
  PopupTextEditorField,
  type CommandPickerOption,
} from "@/components/app-ui/command-fields";
import { DataTable } from "@/components/app-ui/data-table";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard, SurfaceCardContent, SurfaceInset } from "@/components/app-ui/surfaces";
import { SettingsSegmentedTabs } from "@/components/profile/settings-ui";
import { RiaCompatibilityState } from "@/components/ria/ria-page-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import {
  preloadTickerUniverse,
  searchTickerUniverseRemote,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useVault } from "@/lib/vault/vault-context";
import {
  isIAMSchemaNotReadyError,
  RiaService,
  type RiaAvoidRow,
  type RiaPickPackage,
  type RiaPickRow,
  type RiaScreeningRow,
  type RiaScreeningSection,
} from "@/lib/services/ria-service";
import { cn } from "@/lib/utils";

type PicksSource = "kai" | "my";
type PicksCategory = "top-picks" | "avoid" | "screening";
type ScreeningSectionKey = "investable_requirements" | "automatic_avoid_triggers" | "the_math";

type DraftTopPickRow = {
  id: string;
  ticker: string;
  company_name: string;
  sector: string;
  tier: string;
  investment_thesis: string;
};

type DraftAvoidRow = {
  id: string;
  ticker: string;
  company_name: string;
  sector: string;
  category: string;
  why_avoid: string;
  note: string;
};

type DraftScreeningRow = {
  id: string;
  title: string;
  detail: string;
  value_text: string;
};

type DraftScreeningSection = {
  section: ScreeningSectionKey;
  rows: DraftScreeningRow[];
};

type DraftPickPackage = {
  top_picks: DraftTopPickRow[];
  avoid_rows: DraftAvoidRow[];
  screening_sections: DraftScreeningSection[];
  package_note: string;
};

type ValidationState = {
  packageErrors: string[];
  rowErrors: Record<string, string[]>;
};

type ValidationIssueItem = {
  rowId: string;
  category: PicksCategory;
  title: string;
  messages: string[];
};

const TIER_CONFIG: Record<string, { icon: typeof Crown; color: string }> = {
  ACE: { icon: Crown, color: "text-fuchsia-600 dark:text-fuchsia-400" },
  KING: { icon: Trophy, color: "text-amber-600 dark:text-amber-400" },
  QUEEN: { icon: Star, color: "text-violet-600 dark:text-violet-400" },
  JACK: { icon: Medal, color: "text-sky-600 dark:text-sky-400" },
};

const TIER_OPTIONS = Object.keys(TIER_CONFIG);
const TIER_COMMAND_OPTIONS: CommandPickerOption[] = TIER_OPTIONS.map((tier) => ({
  value: tier,
  label: tier,
  description: `${tier} conviction band`,
}));

const DEFAULT_AVOID_CATEGORIES = [
  "Governance",
  "Leverage",
  "Quality",
  "Regulatory",
  "Cyclicality",
  "Valuation",
];

const SCREENING_SECTIONS: Array<{ key: ScreeningSectionKey; label: string; blurb: string }> = [
  {
    key: "investable_requirements",
    label: "Investable requirements",
    blurb: "Non-negotiables that a company must satisfy before it can enter the live debate universe.",
  },
  {
    key: "automatic_avoid_triggers",
    label: "Automatic avoid triggers",
    blurb: "Hard stops and fast-fail signals that should move a name out of consideration.",
  },
  {
    key: "the_math",
    label: "The math",
    blurb: "Repeatable thresholds, scorecards, and quantified hurdles the debate engine should carry into review.",
  },
];

function generateId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTopPickRow(seed?: Partial<RiaPickRow>): DraftTopPickRow {
  return {
    id: generateId("top"),
    ticker: String(seed?.ticker || "").toUpperCase(),
    company_name: String(seed?.company_name || ""),
    sector: String(seed?.sector || ""),
    tier: String(seed?.tier || "").toUpperCase(),
    investment_thesis: String(seed?.investment_thesis || ""),
  };
}

function createAvoidRow(seed?: Partial<RiaAvoidRow>): DraftAvoidRow {
  return {
    id: generateId("avoid"),
    ticker: String(seed?.ticker || "").toUpperCase(),
    company_name: String(seed?.company_name || ""),
    sector: String(seed?.sector || ""),
    category: String(seed?.category || ""),
    why_avoid: String(seed?.why_avoid || ""),
    note: String(seed?.note || ""),
  };
}

function createScreeningRow(seed?: Partial<RiaScreeningRow>): DraftScreeningRow {
  return {
    id: generateId("screen"),
    title: String(seed?.title || ""),
    detail: String(seed?.detail || ""),
    value_text: String(seed?.value_text || ""),
  };
}

function dedupeMathRows(rows: DraftScreeningRow[]): DraftScreeningRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const signature = `${row.title.trim().toLowerCase()}|${row.detail.trim().toLowerCase()}|${row.value_text.trim().toLowerCase()}`;
    if (!signature.replaceAll("|", "")) return true;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function normalizeScreeningDisplayRows<T extends { title?: string | null; detail?: string | null; value_text?: string | null }>(
  rows: T[],
  sectionKey: string
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const title = String(row.title || "").trim().toLowerCase();
    const detail = String(row.detail || "").trim().toLowerCase();
    const value = String(row.value_text || "").trim().toLowerCase();
    const signature = `${sectionKey}|${title}|${detail}|${value}`;
    if (sectionKey === "the_math") {
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
    }
    return true;
  });
}

function shouldRenderScreeningDetail(rule: {
  title?: string | null;
  detail?: string | null;
  value_text?: string | null;
}) {
  const title = String(rule.title || "").trim().toLowerCase();
  const detail = String(rule.detail || "").trim();
  if (!detail) return false;
  return detail.toLowerCase() !== title;
}

function shouldRenderScreeningValue(rule: {
  title?: string | null;
  detail?: string | null;
  value_text?: string | null;
}) {
  const value = String(rule.value_text || "").trim();
  if (!value) return false;
  const title = String(rule.title || "").trim().toLowerCase();
  const detail = String(rule.detail || "").trim().toLowerCase();
  const normalizedValue = value.toLowerCase();
  return normalizedValue !== title && normalizedValue !== detail;
}

function createDraftPackage(source?: RiaPickPackage | null): DraftPickPackage {
  const screeningMap = new Map<string, RiaScreeningSection>();
  for (const section of source?.screening_sections || []) {
    screeningMap.set(section.section, section);
  }

  return {
    top_picks:
      source?.top_picks?.length
        ? source.top_picks.map((row) => createTopPickRow(row))
        : [],
    avoid_rows:
      source?.avoid_rows?.length
        ? source.avoid_rows.map((row) => createAvoidRow(row))
        : [],
    screening_sections: SCREENING_SECTIONS.map((section) => {
      const rows = (screeningMap.get(section.key)?.rows || []).map((row) => createScreeningRow(row));
      return {
        section: section.key,
        rows: section.key === "the_math" ? dedupeMathRows(rows) : rows,
      };
    }),
    package_note: String(source?.package_note || ""),
  };
}

function draftToPayload(draft: DraftPickPackage): RiaPickPackage & { package_note?: string } {
  return {
    top_picks: draft.top_picks.map((row, index) => ({
      ticker: row.ticker.trim().toUpperCase(),
      company_name: row.company_name.trim(),
      sector: row.sector.trim(),
      tier: row.tier.trim().toUpperCase(),
      investment_thesis: row.investment_thesis.trim(),
      tier_rank: index + 1,
    })),
    avoid_rows: draft.avoid_rows.map((row) => ({
      ticker: row.ticker.trim().toUpperCase(),
      company_name: row.company_name.trim(),
      sector: row.sector.trim(),
      category: row.category.trim() || null,
      why_avoid: row.why_avoid.trim(),
      note: row.note.trim() || null,
    })),
    screening_sections: draft.screening_sections.map((section) => ({
      section: section.section,
      rows: (section.section === "the_math" ? dedupeMathRows(section.rows) : section.rows).map(
        (row, index) => ({
          rule_index: index + 1,
          title: row.title.trim(),
          detail: row.detail.trim(),
          value_text: row.value_text.trim() || null,
        })
      ),
    })),
    package_note: draft.package_note.trim() || undefined,
  };
}

function packageFingerprint(value: RiaPickPackage | DraftPickPackage | null | undefined) {
  if (!value) return "";
  return JSON.stringify(draftToPayload(createDraftPackage(value as RiaPickPackage)));
}

function TierBadge({ tier }: { tier?: string | null }) {
  const normalizedTier = String(tier || "").toUpperCase();
  const config = TIER_CONFIG[normalizedTier];
  if (!config) {
    return <span className="text-xs text-muted-foreground">{tier || "—"}</span>;
  }
  const Icon = config.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", config.color)}>
      <Icon className="h-3.5 w-3.5" />
      {normalizedTier}
    </span>
  );
}

function TierSummary({ rows }: { rows: RiaPickRow[] }) {
  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = String(row.tier || "OTHER").toUpperCase();
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [rows]);

  if (Object.keys(tierCounts).length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(TIER_CONFIG).map(([tier, config]) => {
        const count = tierCounts[tier] || 0;
        if (count === 0) return null;
        const Icon = config.icon;
        return (
          <SurfaceInset
            key={tier}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
          >
            <Icon className={cn("h-3.5 w-3.5", config.color)} />
            <span className="font-semibold text-foreground">{count}</span>
            <span className="text-xs text-muted-foreground">{tier}</span>
          </SurfaceInset>
        );
      })}
    </div>
  );
}

function UploadPanel({
  label,
  fileName,
  fileContent,
  submitting,
  onLabelChange,
  onFileSelected,
  onUpload,
}: {
  label: string;
  fileName: string;
  fileContent: string;
  submitting: boolean;
  onLabelChange: (value: string) => void;
  onFileSelected: (file: File | null) => void;
  onUpload: () => void;
}) {
  return (
    <SurfaceCard data-testid="ria-picks-upload-panel">
      <SurfaceCardContent className="space-y-4 p-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Upload a top-picks CSV</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            CSV parsing still works, but it now feeds the same live package save path as the inline
            editor. Your current avoid and screening rules stay attached.
          </p>
        </div>
        <div className="space-y-3">
          <input
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            placeholder="Label, e.g. Q2 growth rotation"
            className="flex h-10 w-full rounded-[16px] border border-border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/70"
          />
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
          {fileName ? (
            <p className="text-xs text-muted-foreground">
              Ready: <span className="font-medium text-foreground">{fileName}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="blue-gradient"
              effect="fill"
              size="sm"
              onClick={onUpload}
              disabled={submitting || !fileContent.trim()}
            >
              <Upload className="mr-2 h-4 w-4" />
              {submitting ? "Uploading..." : "Upload and replace top picks"}
            </Button>
            <Button asChild variant="none" effect="fade" size="sm">
              <a href="/templates/ria-picks-template.csv" download>
                <Download className="mr-2 h-4 w-4" />
                Download template
              </a>
            </Button>
          </div>
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function EmptyMyListState() {
  return (
    <SurfaceCard data-testid="ria-picks-active">
      <SurfaceCardContent className="p-6">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          Build your live advisor package
        </h3>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Your linked investors will consume this package in Kai&apos;s debate flow. Start from
          Kai&apos;s current universe, use the editor above to shape your tiers and thesis, or
          upload a CSV that replaces top picks while keeping the same validation standards.
        </p>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function InlineValidationBanner({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="rounded-[18px] border border-rose-200/80 bg-rose-50/90 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
      {errors.join(" ")}
    </div>
  );
}

function RowErrorNotice({ errors }: { errors: string[] | undefined }) {
  if (!errors || errors.length === 0) return null;
  return (
    <div className="rounded-[12px] border border-rose-200/70 bg-rose-50/80 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
      {errors.join(" ")}
    </div>
  );
}

function ValidationIssuesPanel({
  issues,
  showIssuesOnly,
  onToggleShowIssuesOnly,
  onJumpToIssue,
}: {
  issues: ValidationIssueItem[];
  showIssuesOnly: boolean;
  onToggleShowIssuesOnly: () => void;
  onJumpToIssue: (issue: ValidationIssueItem) => void;
}) {
  if (issues.length === 0) return null;
  return (
    <SurfaceCard>
      <SurfaceCardContent className="space-y-4 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <p className="text-sm font-semibold text-foreground">
                {issues.length} row{issues.length === 1 ? "" : "s"} need attention
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Jump straight to invalid rows or filter the editor down to issues only.
            </p>
          </div>
          <Button
            variant="none"
            effect="fade"
            size="sm"
            onClick={onToggleShowIssuesOnly}
            className="w-full justify-center sm:w-auto"
          >
            {showIssuesOnly ? "Show all rows" : "Show issues only"}
          </Button>
        </div>
        <div className="grid gap-2">
          {issues.map((issue) => (
            <button
              key={issue.rowId}
              type="button"
              onClick={() => onJumpToIssue(issue)}
              className="rounded-[18px] border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-left transition hover:border-amber-300 hover:bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/10 dark:hover:bg-amber-500/15"
            >
              <p className="text-sm font-semibold text-foreground">{issue.title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{issue.messages.join(" ")}</p>
            </button>
          ))}
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function DenseCellInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & {
    invalid?: boolean;
    tone?: "editable" | "derived";
  }
) {
  const { invalid, className, tone = "editable", ...rest } = props;
  return (
    <input
      {...rest}
      className={cn(
        "h-9 w-full rounded-[14px] border px-2.5 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/70",
        invalid ? "border-rose-300 dark:border-rose-500/50" : "border-border/80",
        tone === "derived"
          ? "bg-muted/[0.72] text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] read-only:cursor-default"
          : "bg-background text-foreground",
        className
      )}
    />
  );
}

async function loadTickerCommandOptions(query: string): Promise<CommandPickerOption<TickerUniverseRow>[]> {
  const normalizedQuery = query.trim().toUpperCase();
  if (!normalizedQuery) return [];

  const localUniverse = await preloadTickerUniverse();
  const localMatches = localUniverse
    .filter((row) => {
      const ticker = row.ticker.toUpperCase();
      const title = String(row.title || "").toUpperCase();
      return row.tradable !== false && (ticker.includes(normalizedQuery) || title.includes(normalizedQuery));
    })
    .slice(0, 8);

  let remoteMatches: TickerUniverseRow[] = [];
  try {
    remoteMatches = await searchTickerUniverseRemote(normalizedQuery, 8);
  } catch {}

  const combined = [...localMatches];
  for (const row of remoteMatches) {
    if (!combined.some((item) => item.ticker === row.ticker)) {
      combined.push(row);
    }
  }

  return combined.slice(0, 8).map((row) => ({
    value: row.ticker.toUpperCase(),
    label: row.ticker.toUpperCase(),
    description: row.title || row.ticker,
    supportingLabel: row.sector_primary || row.sector || "Unclassified",
    keywords: [row.title || "", row.sector_primary || "", row.sector || ""],
    data: row,
  }));
}

function TickerLookupField({
  rowId,
  value,
  onResolvedRow,
  invalid,
}: {
  rowId: string;
  value: string;
  onResolvedRow: (rowId: string, value: string, metadata: TickerUniverseRow | null) => void;
  invalid?: boolean;
}) {
  return (
    <CommandPickerField<TickerUniverseRow>
      title="Select a ticker"
      description="Search the SEC-backed symbol universe."
      value={value}
      displayValue={value}
      placeholder="Search SEC ticker"
      searchPlaceholder="Search SEC-backed symbol..."
      emptyText="No valid SEC ticker matches this query."
      invalid={invalid}
      allowClear
      loadOptions={loadTickerCommandOptions}
      onSelect={(option) => onResolvedRow(rowId, option?.value || "", option?.data || null)}
      renderOption={(option, selected) => (
        <>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold tracking-tight text-foreground">{option.label}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {option.supportingLabel || "Unclassified"}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">{option.description}</p>
          </div>
          {selected ? <span className="text-xs font-medium text-primary">Selected</span> : null}
        </>
      )}
    />
  );
}

function MobileEditorField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

const EDITOR_PAGE_SIZE = 8;

function EditorPagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (totalItems <= pageSize) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);
  return (
    <div className="flex flex-col gap-2 border-t border-border/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        Showing {start}-{end} of {totalItems}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button
          variant="none"
          effect="fade"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="w-full justify-center sm:w-auto"
        >
          Previous
        </Button>
        <Button
          variant="none"
          effect="fade"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="w-full justify-center sm:w-auto"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function TopPicksEditor({
  rows,
  errors,
  showIssuesOnly,
  focusedRowId,
  packageSaving,
  saveDisabled,
  onAddRow,
  onRemoveRow,
  onRowChange,
  onTickerResolved,
  onSave,
}: {
  rows: DraftTopPickRow[];
  errors: Record<string, string[]>;
  showIssuesOnly: boolean;
  focusedRowId: string | null;
  packageSaving: boolean;
  saveDisabled: boolean;
  onAddRow: () => void;
  onRemoveRow: (id: string) => void;
  onRowChange: (id: string, field: keyof DraftTopPickRow, value: string) => void;
  onTickerResolved: (id: string, value: string, metadata: TickerUniverseRow | null) => void;
  onSave: () => void;
}) {
  const [page, setPage] = useState(1);
  const filteredRows = useMemo(
    () => (showIssuesOnly ? rows.filter((row) => Boolean(errors[row.id]?.length)) : rows),
    [errors, rows, showIssuesOnly]
  );
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / EDITOR_PAGE_SIZE));
  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);
  useEffect(() => {
    if (!focusedRowId) return;
    const index = filteredRows.findIndex((row) => row.id === focusedRowId);
    if (index >= 0) {
      setPage(Math.floor(index / EDITOR_PAGE_SIZE) + 1);
    }
  }, [filteredRows, focusedRowId]);
  const visibleRows = useMemo(() => {
    const start = (page - 1) * EDITOR_PAGE_SIZE;
    return filteredRows.slice(start, start + EDITOR_PAGE_SIZE);
  }, [filteredRows, page]);

  return (
    <SurfaceCard data-testid="ria-picks-inline-editor">
      <SurfaceCardContent className="p-0">
        <div className="space-y-3 border-b border-border/50 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Top picks</h3>
            <p className="text-xs text-muted-foreground">
              SEC-backed tickers only. Company and sector map from the maintained symbol master.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 sm:justify-end">
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => {
                onAddRow();
                setPage(Math.ceil((filteredRows.length + 1) / EDITOR_PAGE_SIZE));
              }}
              className="w-full justify-center"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add row
            </Button>
            <Button
              variant="blue-gradient"
              effect="fill"
              size="sm"
              onClick={onSave}
              disabled={packageSaving || saveDisabled}
              className="w-full justify-center"
            >
              <Save className="mr-2 h-4 w-4" />
              {packageSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
        <div className="space-y-3 p-3 md:hidden">
          {visibleRows.map((row, index) => {
            const displayIndex = (page - 1) * EDITOR_PAGE_SIZE + index + 1;
            return (
            <SurfaceInset
              key={row.id}
              className={cn(
                "space-y-3 p-3",
                focusedRowId === row.id && "ring-2 ring-amber-300/70 dark:ring-amber-500/40"
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Top pick {displayIndex}</p>
                  <p className="text-xs text-muted-foreground">Compact mobile editor</p>
                </div>
                <Button variant="none" effect="fade" size="sm" onClick={() => onRemoveRow(row.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <MobileEditorField label="Ticker">
                <TickerLookupField
                  rowId={row.id}
                  value={row.ticker}
                  onResolvedRow={onTickerResolved}
                  invalid={Boolean(errors[row.id]?.length)}
                />
                <RowErrorNotice errors={errors[row.id]} />
              </MobileEditorField>
              <div className="grid gap-3 sm:grid-cols-2">
                <MobileEditorField label="Company">
                  <DenseCellInput value={row.company_name} readOnly tone="derived" />
                </MobileEditorField>
                <MobileEditorField label="Sector">
                  <DenseCellInput value={row.sector} readOnly tone="derived" />
                </MobileEditorField>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,0.65fr)_minmax(0,1fr)]">
                <MobileEditorField label="Tier">
                  <CommandPickerField
                    title="Select tier"
                    description="Choose the conviction band the investor debate should inherit."
                    value={row.tier}
                    placeholder="Tier"
                    options={TIER_COMMAND_OPTIONS}
                    allowClear
                    invalid={Boolean(errors[row.id]?.length)}
                    onSelect={(option) => onRowChange(row.id, "tier", option?.value || "")}
                    triggerClassName="min-h-11"
                  />
                </MobileEditorField>
                <MobileEditorField label="Investment thesis">
                  <PopupTextEditorField
                    title={`Investment thesis for ${row.ticker || `top pick ${displayIndex}`}`}
                    description="Keep the list compact, then edit the full thesis in this focused editor."
                    value={row.investment_thesis}
                    placeholder="Why this name belongs in the live debate universe"
                    previewPlaceholder="Add the investment thesis"
                    invalid={Boolean(errors[row.id]?.length)}
                    onSave={(value) => onRowChange(row.id, "investment_thesis", value)}
                    triggerClassName="min-h-[56px] px-3 py-2.5"
                    previewClassName="line-clamp-2 text-xs leading-5"
                  />
                </MobileEditorField>
              </div>
            </SurfaceInset>
            );
          })}
        </div>
        <div className="hidden max-h-[62vh] overflow-auto md:block">
          <Table className="min-w-[880px]">
            <TableHeader className="sticky top-0 z-10 bg-[color:var(--app-card-surface-default-solid)] backdrop-blur">
              <TableRow className="border-border/50">
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Ticker</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Company</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Sector</TableHead>
                <TableHead className="w-[120px] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Tier</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Investment thesis</TableHead>
                <TableHead className="w-[72px] px-3 py-2 text-right text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Row</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => (
                <TableRow key={row.id} className="align-top">
                  <TableCell className="space-y-2 px-3 py-2.5 align-top">
                    <TickerLookupField
                      rowId={row.id}
                      value={row.ticker}
                      onResolvedRow={onTickerResolved}
                      invalid={Boolean(errors[row.id]?.length)}
                    />
                    <RowErrorNotice errors={errors[row.id]} />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <DenseCellInput value={row.company_name} readOnly tone="derived" />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <DenseCellInput value={row.sector} readOnly tone="derived" />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <CommandPickerField
                      title="Select tier"
                      description="Choose the conviction band the investor debate should inherit."
                      value={row.tier}
                      placeholder="Tier"
                      options={TIER_COMMAND_OPTIONS}
                      allowClear
                      invalid={Boolean(errors[row.id]?.length)}
                      onSelect={(option) => onRowChange(row.id, "tier", option?.value || "")}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <PopupTextEditorField
                      title={`Investment thesis for ${row.ticker || "this top pick"}`}
                      description="Keep the table dense while editing the full thesis in a dedicated popup."
                      value={row.investment_thesis}
                      placeholder="Why this name belongs in the live debate universe"
                      previewPlaceholder="Add the investment thesis"
                      invalid={Boolean(errors[row.id]?.length)}
                      onSave={(value) => onRowChange(row.id, "investment_thesis", value)}
                      triggerClassName="min-h-[56px] px-3 py-2.5"
                      previewClassName="line-clamp-2 text-xs leading-5"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <div className="flex justify-end">
                      <Button variant="none" effect="fade" size="sm" onClick={() => onRemoveRow(row.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <EditorPagination
          page={page}
          totalPages={totalPages}
          totalItems={filteredRows.length}
          pageSize={EDITOR_PAGE_SIZE}
          onPageChange={setPage}
        />
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function AvoidEditor({
  rows,
  errors,
  showIssuesOnly,
  focusedRowId,
  categoryOptions,
  packageSaving,
  saveDisabled,
  onAddRow,
  onRemoveRow,
  onRowChange,
  onTickerResolved,
  onSave,
}: {
  rows: DraftAvoidRow[];
  errors: Record<string, string[]>;
  showIssuesOnly: boolean;
  focusedRowId: string | null;
  categoryOptions: CommandPickerOption[];
  packageSaving: boolean;
  saveDisabled: boolean;
  onAddRow: () => void;
  onRemoveRow: (id: string) => void;
  onRowChange: (id: string, field: keyof DraftAvoidRow, value: string) => void;
  onTickerResolved: (id: string, value: string, metadata: TickerUniverseRow | null) => void;
  onSave: () => void;
}) {
  const [page, setPage] = useState(1);
  const filteredRows = useMemo(
    () => (showIssuesOnly ? rows.filter((row) => Boolean(errors[row.id]?.length)) : rows),
    [errors, rows, showIssuesOnly]
  );
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / EDITOR_PAGE_SIZE));
  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);
  useEffect(() => {
    if (!focusedRowId) return;
    const index = filteredRows.findIndex((row) => row.id === focusedRowId);
    if (index >= 0) {
      setPage(Math.floor(index / EDITOR_PAGE_SIZE) + 1);
    }
  }, [filteredRows, focusedRowId]);
  const visibleRows = useMemo(() => {
    const start = (page - 1) * EDITOR_PAGE_SIZE;
    return filteredRows.slice(start, start + EDITOR_PAGE_SIZE);
  }, [filteredRows, page]);

  return (
    <SurfaceCard data-testid="ria-picks-inline-editor">
      <SurfaceCardContent className="p-0">
        <div className="space-y-3 border-b border-border/50 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Avoid</h3>
            <p className="text-xs text-muted-foreground">
              Anything here becomes a hard or soft exclusion signal in the investor debate flow.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 sm:justify-end">
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => {
                onAddRow();
                setPage(Math.ceil((filteredRows.length + 1) / EDITOR_PAGE_SIZE));
              }}
              className="w-full justify-center"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add row
            </Button>
            <Button
              variant="blue-gradient"
              effect="fill"
              size="sm"
              onClick={onSave}
              disabled={packageSaving || saveDisabled}
              className="w-full justify-center"
            >
              <Save className="mr-2 h-4 w-4" />
              {packageSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
        <div className="space-y-3 p-3 md:hidden">
          {visibleRows.map((row, index) => {
            const displayIndex = (page - 1) * EDITOR_PAGE_SIZE + index + 1;
            return (
            <SurfaceInset
              key={row.id}
              className={cn(
                "space-y-3 p-3",
                focusedRowId === row.id && "ring-2 ring-amber-300/70 dark:ring-amber-500/40"
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Avoid row {displayIndex}</p>
                  <p className="text-xs text-muted-foreground">Compact mobile editor</p>
                </div>
                <Button variant="none" effect="fade" size="sm" onClick={() => onRemoveRow(row.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <MobileEditorField label="Ticker">
                <TickerLookupField
                  rowId={row.id}
                  value={row.ticker}
                  onResolvedRow={onTickerResolved}
                  invalid={Boolean(errors[row.id]?.length)}
                />
                <RowErrorNotice errors={errors[row.id]} />
              </MobileEditorField>
              <div className="grid gap-3 sm:grid-cols-2">
                <MobileEditorField label="Company">
                  <DenseCellInput value={row.company_name} readOnly tone="derived" />
                </MobileEditorField>
                <MobileEditorField label="Sector">
                  <DenseCellInput value={row.sector} readOnly tone="derived" />
                </MobileEditorField>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,0.65fr)_minmax(0,1fr)]">
                <MobileEditorField label="Category">
                  <CommandPickerField
                    title={`Avoid category for ${row.ticker || `avoid row ${index + 1}`}`}
                    description="Use a shared category language so the linked-investor debate reads consistently."
                    value={row.category}
                    placeholder="Select category"
                    options={categoryOptions}
                    allowClear
                    onSelect={(option) => onRowChange(row.id, "category", option?.value || "")}
                    triggerClassName="min-h-11"
                  />
                </MobileEditorField>
                <MobileEditorField label="Reason">
                  <PopupTextEditorField
                    title={`Avoid reason for ${row.ticker || `avoid row ${displayIndex}`}`}
                    description="Capture the exclusion logic in a focused editor instead of a cramped inline textarea."
                    value={row.why_avoid}
                    placeholder="Why this name should be screened out"
                    previewPlaceholder="Add the avoid reason"
                    invalid={Boolean(errors[row.id]?.length)}
                    onSave={(value) => onRowChange(row.id, "why_avoid", value)}
                    triggerClassName="min-h-[56px] px-3 py-2.5"
                    previewClassName="line-clamp-2 text-xs leading-5"
                  />
                </MobileEditorField>
              </div>
              <MobileEditorField label="Note">
                <PopupTextEditorField
                  title={`Advisor note for ${row.ticker || `avoid row ${index + 1}`}`}
                  description="Optional context for your team or future review."
                  value={row.note}
                  placeholder="Optional context for the advisor team"
                  previewPlaceholder="Add an optional note"
                  onSave={(value) => onRowChange(row.id, "note", value)}
                  triggerClassName="min-h-[56px] px-3 py-2.5"
                  previewClassName="line-clamp-2 text-xs leading-5"
                />
              </MobileEditorField>
            </SurfaceInset>
            );
          })}
        </div>
        <div className="hidden max-h-[62vh] overflow-auto md:block">
          <Table className="min-w-[920px]">
            <TableHeader className="sticky top-0 z-10 bg-[color:var(--app-card-surface-default-solid)] backdrop-blur">
              <TableRow className="border-border/50">
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Ticker</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Company</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Sector</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Category</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Reason</TableHead>
                <TableHead className="px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Note</TableHead>
                <TableHead className="w-[72px] px-3 py-2 text-right text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Row</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => (
                <TableRow key={row.id} className="align-top">
                  <TableCell className="space-y-2 px-3 py-2.5 align-top">
                    <TickerLookupField
                      rowId={row.id}
                      value={row.ticker}
                      onResolvedRow={onTickerResolved}
                      invalid={Boolean(errors[row.id]?.length)}
                    />
                    <RowErrorNotice errors={errors[row.id]} />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <DenseCellInput value={row.company_name} readOnly tone="derived" />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <DenseCellInput value={row.sector} readOnly tone="derived" />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <CommandPickerField
                      title={`Avoid category for ${row.ticker || "this avoid row"}`}
                      description="Use a shared category language so the linked-investor debate reads consistently."
                      value={row.category}
                      placeholder="Select category"
                      options={categoryOptions}
                      allowClear
                      onSelect={(option) => onRowChange(row.id, "category", option?.value || "")}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <PopupTextEditorField
                      title={`Avoid reason for ${row.ticker || "this avoid row"}`}
                      description="Capture the exclusion logic in a focused editor instead of a cramped inline textarea."
                      value={row.why_avoid}
                      placeholder="Why this name should be screened out"
                      previewPlaceholder="Add the avoid reason"
                      invalid={Boolean(errors[row.id]?.length)}
                      onSave={(value) => onRowChange(row.id, "why_avoid", value)}
                      triggerClassName="min-h-[56px] px-3 py-2.5"
                      previewClassName="line-clamp-2 text-xs leading-5"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <PopupTextEditorField
                      title={`Advisor note for ${row.ticker || "this avoid row"}`}
                      description="Optional context for your team or future review."
                      value={row.note}
                      placeholder="Optional context for the advisor team"
                      previewPlaceholder="Add an optional note"
                      onSave={(value) => onRowChange(row.id, "note", value)}
                      triggerClassName="min-h-[56px] px-3 py-2.5"
                      previewClassName="line-clamp-2 text-xs leading-5"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top">
                    <div className="flex justify-end">
                      <Button variant="none" effect="fade" size="sm" onClick={() => onRemoveRow(row.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <EditorPagination
          page={page}
          totalPages={totalPages}
          totalItems={filteredRows.length}
          pageSize={EDITOR_PAGE_SIZE}
          onPageChange={setPage}
        />
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function ScreeningEditor({
  sections,
  errors,
  showIssuesOnly,
  focusedRowId,
  packageSaving,
  saveDisabled,
  onAddRow,
  onRemoveRow,
  onRowChange,
  onSave,
}: {
  sections: DraftScreeningSection[];
  errors: Record<string, string[]>;
  showIssuesOnly: boolean;
  focusedRowId: string | null;
  packageSaving: boolean;
  saveDisabled: boolean;
  onAddRow: (section: ScreeningSectionKey) => void;
  onRemoveRow: (section: ScreeningSectionKey, rowId: string) => void;
  onRowChange: (
    section: ScreeningSectionKey,
    rowId: string,
    field: keyof DraftScreeningRow,
    value: string
  ) => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-4" data-testid="ria-picks-inline-editor">
      <SurfaceCard>
        <SurfaceCardContent className="space-y-3 p-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Screening</h3>
            <p className="text-xs text-muted-foreground">
              Keep the fixed screening taxonomy, but update the rules Kai should carry into investor debates.
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              variant="blue-gradient"
              effect="fill"
              size="sm"
              onClick={onSave}
              disabled={packageSaving || saveDisabled}
              className="w-full justify-center sm:w-auto"
            >
              <Save className="mr-2 h-4 w-4" />
              {packageSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </SurfaceCardContent>
      </SurfaceCard>
      <div className="max-h-[62vh] space-y-4 overflow-y-auto">
      {SCREENING_SECTIONS.map((section) => {
        const currentSection = sections.find((item) => item.section === section.key);
        const rows = currentSection?.rows || [];
        const filteredRows = showIssuesOnly
          ? rows.filter((row) => Boolean(errors[row.id]?.length))
          : rows;
        if (showIssuesOnly && filteredRows.length === 0) {
          return null;
        }
        return (
          <SurfaceCard key={section.key}>
            <SurfaceCardContent className="space-y-4 p-4">
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{section.label}</h3>
                  <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
                    {section.blurb}
                  </p>
                </div>
                <div className="flex justify-start sm:justify-end">
                  <Button variant="none" effect="fade" size="sm" onClick={() => onAddRow(section.key)} className="w-full justify-center sm:w-auto">
                    <Plus className="mr-2 h-4 w-4" />
                    Add rule
                  </Button>
                </div>
              </div>
              <div className="space-y-3">
                {filteredRows.length === 0 ? (
                  <SurfaceInset className="px-4 py-3 text-sm text-muted-foreground">
                    No rules yet. Add the rubric you want Kai to carry into the investor debate.
                  </SurfaceInset>
                ) : null}
                {filteredRows.map((row) => (
                  <SurfaceInset
                    key={row.id}
                    className={cn(
                      "space-y-3 p-3",
                      focusedRowId === row.id && "ring-2 ring-amber-300/70 dark:ring-amber-500/40"
                    )}
                  >
                    <div className="grid gap-3 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_auto]">
                      <DenseCellInput
                        value={row.title}
                        onChange={(event) => onRowChange(section.key, row.id, "title", event.target.value)}
                        placeholder="Rule title"
                        invalid={Boolean(errors[row.id]?.length)}
                      />
                      <PopupTextEditorField
                        title={`Rule detail for ${row.title || "this screening rule"}`}
                        description="Explain the screening logic in plain language without squeezing it into the grid."
                        value={row.detail}
                        placeholder="Explain the rule in plain language"
                        previewPlaceholder="Add the rule detail"
                        invalid={Boolean(errors[row.id]?.length)}
                        onSave={(value) => onRowChange(section.key, row.id, "detail", value)}
                        triggerClassName="min-h-[56px] px-3 py-2.5"
                        previewClassName="line-clamp-2 text-xs leading-5"
                      />
                      <DenseCellInput
                        value={row.value_text}
                        onChange={(event) => onRowChange(section.key, row.id, "value_text", event.target.value)}
                        placeholder="Threshold / value"
                      />
                      <div className="flex items-start justify-end">
                        <Button
                          variant="none"
                          effect="fade"
                          size="sm"
                          onClick={() => onRemoveRow(section.key, row.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <RowErrorNotice errors={errors[row.id]} />
                  </SurfaceInset>
                ))}
              </div>
            </SurfaceCardContent>
          </SurfaceCard>
        );
      })}
      </div>
    </div>
  );
}

export default function RiaPicksPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { riaCapability, loading: personaLoading, refreshing: personaRefreshing } = usePersonaState();

  const [source, setSource] = useState<PicksSource>("kai");
  const [category, setCategory] = useState<PicksCategory>("top-picks");
  const [label, setLabel] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [savingToMyList, setSavingToMyList] = useState(false);
  const [packageSaving, setPackageSaving] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showIssuesOnly, setShowIssuesOnly] = useState(false);
  const [focusedIssueRowId, setFocusedIssueRowId] = useState<string | null>(null);
  const [draftPackage, setDraftPackage] = useState<DraftPickPackage | null>(null);
  const [validationState, setValidationState] = useState<ValidationState>({
    packageErrors: [],
    rowErrors: {},
  });

  const [kaiRows, setKaiRows] = useState<RiaPickRow[]>([]);
  const [kaiLoading, setKaiLoading] = useState(false);
  const [avoidRows, setAvoidRows] = useState<RiaAvoidRow[]>([]);
  const [avoidLoading, setAvoidLoading] = useState(false);
  const [screeningRows, setScreeningRows] = useState<RiaScreeningRow[]>([]);
  const [screeningLoading, setScreeningLoading] = useState(false);

  const picksResource = useStaleResource<{
    package: RiaPickPackage;
    metadata?: {
      has_package: boolean;
      storage_source: "pkm" | "legacy" | "empty";
      package_revision: number;
      top_pick_count: number;
      avoid_count: number;
      screening_row_count: number;
      last_updated?: string | null;
      active_share_count: number;
      path?: string | null;
    };
  }>({
    cacheKey: user?.uid ? `ria_picks_${user.uid}` : "ria_picks_guest",
    enabled: Boolean(user?.uid && (riaCapability !== "setup" || personaRefreshing)),
    load: async () => {
      if (!user?.uid) throw new Error("Sign in");
      const idToken = await user.getIdToken();
      return RiaService.listPicks({
        idToken,
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
    },
  });

  const activePackage = useMemo(
    () => picksResource.data?.package || createDraftPackage(null),
    [picksResource.data?.package]
  );
  const picksMetadata = picksResource.data?.metadata;
  const myTopPicks = activePackage.top_picks || [];
  const myAvoidRows = useMemo(() => activePackage.avoid_rows || [], [activePackage.avoid_rows]);
  const myScreeningSections = activePackage.screening_sections || [];
  const showMyListEmptyState =
    source === "my" &&
    category === "top-picks" &&
    !editing &&
    !picksResource.loading &&
    myTopPicks.length === 0 &&
    !(!isVaultUnlocked && picksResource.data?.metadata?.storage_source === "pkm" && picksResource.data?.metadata?.has_package === true);
  const myListRequiresUnlock =
    source === "my" &&
    !isVaultUnlocked &&
    picksMetadata?.storage_source === "pkm" &&
    picksMetadata?.has_package === true;
  const screeningViewRows = source === "kai"
    ? SCREENING_SECTIONS.map((section) => ({
        section: section.key,
        label: section.label,
        rows: normalizeScreeningDisplayRows<RiaScreeningRow>(
          screeningRows.filter((row) => row.section === section.key),
          section.key
        ),
      }))
    : SCREENING_SECTIONS.map((section) => ({
        section: section.key,
        label: section.label,
        rows: normalizeScreeningDisplayRows<RiaScreeningRow>(
          myScreeningSections.find((item) => item.section === section.key)?.rows || [],
          section.key
        ),
      }));

  const iamUnavailable = Boolean(
    picksResource.error && isIAMSchemaNotReadyError(new Error(picksResource.error))
  );

  const draftFingerprint = packageFingerprint(draftPackage);
  const savedFingerprint = packageFingerprint(activePackage);
  const hasUnsavedChanges = editing && draftFingerprint !== savedFingerprint;
  const validationIssues = useMemo<ValidationIssueItem[]>(() => {
    if (!draftPackage) return [];
    const items: ValidationIssueItem[] = [];
    for (const row of draftPackage.top_picks) {
      const messages = validationState.rowErrors[row.id];
      if (messages?.length) {
        items.push({
          rowId: row.id,
          category: "top-picks",
          title: row.ticker ? `Top picks: ${row.ticker}` : "Top picks: missing ticker",
          messages,
        });
      }
    }
    for (const row of draftPackage.avoid_rows) {
      const messages = validationState.rowErrors[row.id];
      if (messages?.length) {
        items.push({
          rowId: row.id,
          category: "avoid",
          title: row.ticker ? `Avoid: ${row.ticker}` : "Avoid: missing ticker",
          messages,
        });
      }
    }
    for (const section of draftPackage.screening_sections) {
      const sectionLabel =
        SCREENING_SECTIONS.find((item) => item.key === section.section)?.label || "Screening";
      for (const row of section.rows) {
        const messages = validationState.rowErrors[row.id];
        if (messages?.length) {
          items.push({
            rowId: row.id,
            category: "screening",
            title: `${sectionLabel}: ${row.title || "Untitled rule"}`,
            messages,
          });
        }
      }
    }
    return items;
  }, [draftPackage, validationState.rowErrors]);

  useEffect(() => {
    if (!personaLoading && !personaRefreshing && riaCapability === "setup") {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [personaLoading, personaRefreshing, riaCapability, router]);

  useEffect(() => {
    if (!editing) {
      setDraftPackage(createDraftPackage(picksResource.data?.package || null));
      setShowIssuesOnly(false);
      setFocusedIssueRowId(null);
      setValidationState({ packageErrors: [], rowErrors: {} });
    }
  }, [editing, picksResource.data?.package]);

  useEffect(() => {
    if (!user || kaiRows.length > 0) return;
    let cancelled = false;
    void (async () => {
      setKaiLoading(true);
      try {
        const idToken = await user.getIdToken();
        const data = await RiaService.getRenaissanceUniverse(idToken);
        if (!cancelled) setKaiRows(data.items);
      } finally {
        if (!cancelled) setKaiLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kaiRows.length, user]);

  useEffect(() => {
    if (!user || (source !== "kai" && source !== "my") || avoidRows.length > 0) return;
    let cancelled = false;
    void (async () => {
      setAvoidLoading(true);
      try {
        const idToken = await user.getIdToken();
        const data = await RiaService.getRenaissanceAvoid(idToken);
        if (!cancelled) setAvoidRows(data.items);
      } finally {
        if (!cancelled) setAvoidLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [avoidRows.length, source, user]);

  useEffect(() => {
    if (!user || screeningRows.length > 0) return;
    let cancelled = false;
    void (async () => {
      setScreeningLoading(true);
      try {
        const idToken = await user.getIdToken();
        const data = await RiaService.getRenaissanceScreening(idToken);
        if (!cancelled) setScreeningRows(data.items);
      } finally {
        if (!cancelled) setScreeningLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screeningRows.length, user]);

  const sourceOptions = useMemo(
    () => [
      { value: "kai", label: `Kai list (${kaiRows.length || "..."})` },
      { value: "my", label: `My list (${myTopPicks.length})` },
    ],
    [kaiRows.length, myTopPicks.length]
  );

  const categoryOptions = useMemo(
    () => [
      { value: "top-picks", label: "Top picks" },
      { value: "avoid", label: "Avoid" },
      { value: "screening", label: "Screening" },
    ],
    []
  );

  const avoidCategoryOptions = useMemo<CommandPickerOption[]>(() => {
    const values = new Set<string>(DEFAULT_AVOID_CATEGORIES);
    for (const row of avoidRows) {
      if (row.category?.trim()) values.add(row.category.trim());
    }
    for (const row of myAvoidRows) {
      if (row.category?.trim()) values.add(row.category.trim());
    }
    for (const row of draftPackage?.avoid_rows || []) {
      if (row.category.trim()) values.add(row.category.trim());
    }
    return Array.from(values)
      .sort((left, right) => left.localeCompare(right))
      .map((value) => ({
        value,
        label: value,
        description: "Advisor-defined exclusion category",
      }));
  }, [avoidRows, draftPackage?.avoid_rows, myAvoidRows]);

  const pickColumns = useMemo<ColumnDef<RiaPickRow>[]>(
    () => [
      {
        accessorKey: "ticker",
        header: "Ticker",
        cell: ({ row }) => (
          <div className="font-semibold tracking-tight text-foreground">{row.original.ticker}</div>
        ),
      },
      {
        accessorKey: "company_name",
        header: "Company",
        cell: ({ row }) => (
          <div className="min-w-[160px]">
            <p className="font-medium text-foreground">{row.original.company_name || "—"}</p>
            <p className="mt-0.5 text-xs text-muted-foreground sm:hidden">
              {row.original.sector || "—"}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "sector",
        header: "Sector",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{row.original.sector || "—"}</span>
        ),
      },
      {
        accessorKey: "tier",
        header: "Tier",
        cell: ({ row }) => <TierBadge tier={row.original.tier} />,
      },
      {
        accessorKey: "investment_thesis",
        header: "Thesis",
        cell: ({ row }) => (
          <p className="max-w-[360px] text-xs leading-5 text-muted-foreground">
            {row.original.investment_thesis || "—"}
          </p>
        ),
      },
    ],
    []
  );

  const avoidColumns = useMemo<ColumnDef<RiaAvoidRow>[]>(
    () => [
      {
        accessorKey: "ticker",
        header: "Ticker",
        cell: ({ row }) => (
          <div className="font-semibold tracking-tight text-foreground">{row.original.ticker}</div>
        ),
      },
      {
        accessorKey: "company_name",
        header: "Company",
        cell: ({ row }) => (
          <div className="min-w-[160px]">
            <p className="font-medium text-foreground">{row.original.company_name || "—"}</p>
            <p className="mt-0.5 text-xs text-muted-foreground sm:hidden">
              {row.original.sector || "—"}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "category",
        header: "Category",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{row.original.category || "—"}</span>
        ),
      },
      {
        accessorKey: "why_avoid",
        header: "Reason",
        cell: ({ row }) => (
          <p className="max-w-[380px] text-xs leading-5 text-muted-foreground">
            {row.original.why_avoid || "—"}
          </p>
        ),
      },
      {
        accessorKey: "note",
        header: "Note",
        cell: ({ row }) => (
          <p className="max-w-[260px] text-xs leading-5 text-muted-foreground">
            {row.original.note || "—"}
          </p>
        ),
      },
    ],
    []
  );

  function startEditing() {
    setEditing(true);
    setUploadOpen(false);
    setShowIssuesOnly(false);
    setFocusedIssueRowId(null);
    setDraftPackage(createDraftPackage(activePackage));
    setValidationState({ packageErrors: [], rowErrors: {} });
  }

  function discardChanges() {
    setEditing(false);
    setShowIssuesOnly(false);
    setFocusedIssueRowId(null);
    setDraftPackage(createDraftPackage(activePackage));
    setValidationState({ packageErrors: [], rowErrors: {} });
  }

  function updateDraft(nextDraft: DraftPickPackage) {
    setDraftPackage(nextDraft);
    setShowIssuesOnly(false);
    setFocusedIssueRowId(null);
    setValidationState((current) => ({
      packageErrors: current.packageErrors,
      rowErrors: {},
    }));
  }

  function patchTopPickRow(id: string, field: keyof DraftTopPickRow, value: string) {
    if (!draftPackage) return;
    updateDraft({
      ...draftPackage,
      top_picks: draftPackage.top_picks.map((row) =>
        row.id === id ? { ...row, [field]: value } : row
      ),
    });
  }

  function patchAvoidRow(id: string, field: keyof DraftAvoidRow, value: string) {
    if (!draftPackage) return;
    updateDraft({
      ...draftPackage,
      avoid_rows: draftPackage.avoid_rows.map((row) =>
        row.id === id ? { ...row, [field]: value } : row
      ),
    });
  }

  function patchScreeningRow(
    section: ScreeningSectionKey,
    rowId: string,
    field: keyof DraftScreeningRow,
    value: string
  ) {
    if (!draftPackage) return;
    updateDraft({
      ...draftPackage,
      screening_sections: draftPackage.screening_sections.map((item) =>
        item.section === section
          ? {
              ...item,
              rows: item.rows.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)),
            }
          : item
      ),
    });
  }

  const updateTopPickTicker = useCallback(
    (id: string, value: string, metadata: TickerUniverseRow | null) => {
      setDraftPackage((current) => {
        if (!current) return current;
        const normalizedValue = value.trim().toUpperCase();
        return {
          ...current,
          top_picks: current.top_picks.map((row) =>
            row.id === id
              ? {
                  ...row,
                  ticker: normalizedValue,
                  company_name: normalizedValue
                    ? metadata?.title?.trim() || row.company_name
                    : "",
                  sector: normalizedValue
                    ? String(metadata?.sector_primary || metadata?.sector || "").trim() || row.sector
                    : "",
                }
              : row
          ),
        };
      });
      setValidationState((current) => ({ ...current, rowErrors: {} }));
    },
    []
  );

  const updateAvoidTicker = useCallback(
    (id: string, value: string, metadata: TickerUniverseRow | null) => {
      setDraftPackage((current) => {
        if (!current) return current;
        const normalizedValue = value.trim().toUpperCase();
        return {
          ...current,
          avoid_rows: current.avoid_rows.map((row) =>
            row.id === id
              ? {
                  ...row,
                  ticker: normalizedValue,
                  company_name: normalizedValue
                    ? metadata?.title?.trim() || row.company_name
                    : "",
                  sector: normalizedValue
                    ? String(metadata?.sector_primary || metadata?.sector || "").trim() || row.sector
                    : "",
                }
              : row
          ),
        };
      });
      setValidationState((current) => ({ ...current, rowErrors: {} }));
    },
    []
  );

  async function resolveMetadata(ticker: string, lookup: Map<string, TickerUniverseRow>) {
    const normalizedTicker = ticker.trim().toUpperCase();
    if (!normalizedTicker) return null;
    const local = lookup.get(normalizedTicker);
    if (local) return local;
    try {
      const remoteMatches = await searchTickerUniverseRemote(normalizedTicker, 8);
      const exact = remoteMatches.find((row) => row.ticker.toUpperCase() === normalizedTicker) || null;
      if (exact) lookup.set(normalizedTicker, exact);
      return exact;
    } catch {
      return null;
    }
  }

  async function validateDraft(nextDraft: DraftPickPackage): Promise<{
    payload: ReturnType<typeof draftToPayload>;
    validation: ValidationState;
  }> {
    const universe = await preloadTickerUniverse();
    const lookup = new Map(universe.map((row) => [row.ticker.toUpperCase(), row]));
    const rowErrors: Record<string, string[]> = {};
    const packageErrors: string[] = [];
    const seenTop = new Set<string>();
    const seenAvoid = new Set<string>();

    const nextTopRows = await Promise.all(
      nextDraft.top_picks.map(async (row) => {
        const issues: string[] = [];
        const ticker = row.ticker.trim().toUpperCase();
        const metadata = await resolveMetadata(ticker, lookup);
        if (!ticker) issues.push("Ticker is required.");
        if (!metadata || metadata.tradable === false) {
          issues.push("Ticker must be an SEC-backed tradable symbol.");
        }
        if (ticker && seenTop.has(ticker)) {
          issues.push("Ticker appears more than once in Top picks.");
        }
        if (!row.tier.trim()) issues.push("Tier is required.");
        if (!row.investment_thesis.trim()) issues.push("Investment thesis is required.");
        if (issues.length > 0) {
          rowErrors[row.id] = issues;
        } else {
          seenTop.add(ticker);
        }
        return {
          ...row,
          ticker,
          company_name: metadata?.title?.trim() || row.company_name.trim(),
          sector: String(metadata?.sector_primary || metadata?.sector || "").trim() || row.sector.trim(),
          tier: row.tier.trim().toUpperCase(),
          investment_thesis: row.investment_thesis.trim(),
        };
      })
    );

    const nextAvoidRows = await Promise.all(
      nextDraft.avoid_rows.map(async (row) => {
        const issues: string[] = [];
        const ticker = row.ticker.trim().toUpperCase();
        const metadata = await resolveMetadata(ticker, lookup);
        if (!ticker) issues.push("Ticker is required.");
        if (!metadata || metadata.tradable === false) {
          issues.push("Ticker must be an SEC-backed tradable symbol.");
        }
        if (ticker && seenAvoid.has(ticker)) {
          issues.push("Ticker appears more than once in Avoid.");
        }
        if (ticker && seenTop.has(ticker)) {
          issues.push("Ticker cannot appear in both Top picks and Avoid.");
        }
        if (!row.why_avoid.trim()) issues.push("Reason is required.");
        if (issues.length > 0) {
          rowErrors[row.id] = issues;
        } else {
          seenAvoid.add(ticker);
        }
        return {
          ...row,
          ticker,
          company_name: metadata?.title?.trim() || row.company_name.trim(),
          sector: String(metadata?.sector_primary || metadata?.sector || "").trim() || row.sector.trim(),
          category: row.category.trim(),
          why_avoid: row.why_avoid.trim(),
          note: row.note.trim(),
        };
      })
    );

    const nextScreeningSections = nextDraft.screening_sections.map((section) => {
      const dedupedRows = section.section === "the_math" ? dedupeMathRows(section.rows) : section.rows;
      return {
        section: section.section,
        rows: dedupedRows.map((row) => {
          const issues: string[] = [];
          if (!row.title.trim()) issues.push("Rule title is required.");
          if (!row.detail.trim()) issues.push("Rule detail is required.");
          if (issues.length > 0) {
            rowErrors[row.id] = issues;
          }
          return {
            ...row,
            title: row.title.trim(),
            detail: row.detail.trim(),
            value_text: row.value_text.trim(),
          };
        }),
      };
    });

    if (nextTopRows.length === 0) {
      packageErrors.push("Top picks cannot be empty. This list powers the linked-investor debate universe.");
    }

    return {
      payload: draftToPayload({
        ...nextDraft,
        top_picks: nextTopRows,
        avoid_rows: nextAvoidRows,
        screening_sections: nextScreeningSections,
      }),
      validation: { packageErrors, rowErrors },
    };
  }

  async function ensureKaiRowsLoaded(): Promise<RiaPickRow[]> {
    if (!user) return [];
    if (kaiRows.length > 0) return kaiRows;
    const idToken = await user.getIdToken();
    const data = await RiaService.getRenaissanceUniverse(idToken);
    setKaiRows(data.items);
    return data.items;
  }

  async function savePackage(payload: ReturnType<typeof draftToPayload>, nextLabel?: string) {
    if (!user) return;
    const idToken = await user.getIdToken();
    await RiaService.savePickPackage({
      idToken,
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
      label: nextLabel || "Active advisor package",
      package_note: payload.package_note || undefined,
      top_picks: payload.top_picks,
      avoid_rows: payload.avoid_rows,
      screening_sections: payload.screening_sections,
    });
  }

  async function saveKaiAsMyList() {
    try {
      setSavingToMyList(true);
      const topPicks = await ensureKaiRowsLoaded();
      if (topPicks.length === 0) {
        toast.error("Kai list is not available yet");
        return;
      }
      const basePackage = editing && draftPackage ? draftPackage : createDraftPackage(activePackage);
      const nextDraft = {
        ...basePackage,
        top_picks: topPicks.map((row) => createTopPickRow(row)),
      };
      setDraftPackage(nextDraft);
      setShowIssuesOnly(false);
      setFocusedIssueRowId(null);
      setValidationState({ packageErrors: [], rowErrors: {} });
      setSource("my");
      setCategory("top-picks");
      setEditing(true);
      setUploadOpen(false);
      toast.success("Copied from Kai. Save to publish it to My list.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to copy list");
    } finally {
      setSavingToMyList(false);
    }
  }

  async function onUpload() {
    if (!user || !fileContent.trim()) return;
    try {
      setSubmitting(true);
      if (!vaultKey || !vaultOwnerToken) {
        throw new Error("Unlock the vault before importing advisor picks.");
      }
      const idToken = await user.getIdToken();
      await RiaService.importPickCsv({
        idToken,
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        csv_content: fileContent,
        source_filename: fileName || undefined,
        label: label.trim() || "Active advisor package",
        package_note: activePackage.package_note || undefined,
        avoid_rows: activePackage.avoid_rows,
        screening_sections: activePackage.screening_sections,
      });
      toast.success("Top picks uploaded");
      setLabel("");
      setFileName("");
      setFileContent("");
      setSource("my");
      setCategory("top-picks");
      setUploadOpen(false);
      setEditing(false);
      void picksResource.refresh({ force: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveDraftPackage() {
    if (!draftPackage) return;
    try {
      setPackageSaving(true);
      if (!vaultKey || !vaultOwnerToken) {
        throw new Error("Unlock the vault before saving advisor picks.");
      }
      const { payload, validation } = await validateDraft(draftPackage);
      setValidationState(validation);
      if (validation.packageErrors.length > 0 || Object.keys(validation.rowErrors).length > 0) {
        setShowIssuesOnly(true);
        toast.error("Fix the highlighted validation issues before saving.");
        return;
      }
      await savePackage(payload);
      toast.success("Advisor package saved");
      setEditing(false);
      setUploadOpen(false);
      void picksResource.refresh({ force: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save advisor package");
    } finally {
      setPackageSaving(false);
    }
  }

  const sourceTitle = source === "kai" ? "Kai list" : "My list";
  const showMyListActionRail = source === "my";

  if (personaLoading) return null;
  if (riaCapability === "setup") {
    return (
      <RiaCompatibilityState
        title="Complete RIA onboarding"
        description="Finish onboarding to manage picks."
      />
    );
  }

  return (
    <AppPageShell
      as="main"
      width="expanded"
      className="pb-16 sm:pb-24"
      nativeTest={{
        routeId: "/ria/picks",
        marker: "native-route-ria-picks",
        authState: user ? "authenticated" : "pending",
        dataState: picksResource.loading
          ? "loading"
          : iamUnavailable
            ? "unavailable-valid"
            : "loaded",
        errorCode: picksResource.error ? "ria_picks" : null,
        errorMessage: picksResource.error,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Picks"
          title="Stock universe"
          description="Switch between Kai's reference package and your live advisor package without losing the avoid or screening context that feeds linked-investor debates."
          icon={FileSpreadsheet}
          accent="ria"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div className="flex flex-col gap-6">
          <div data-testid="ria-picks-primary">
            <SettingsSegmentedTabs
              value={source}
              onValueChange={(value) => {
                setSource(value as PicksSource);
                setUploadOpen(false);
              }}
              options={sourceOptions}
              mobileColumns={2}
            />
          </div>

          <SettingsSegmentedTabs
            value={category}
            onValueChange={(value) => setCategory(value as PicksCategory)}
            options={categoryOptions}
            mobileColumns={3}
          />

          {showMyListActionRail ? (
            <SurfaceCard>
              <SurfaceCardContent className="space-y-2 p-3 sm:p-4">
                <div className="grid gap-2 sm:grid-cols-2 xl:mx-auto xl:max-w-[28rem]">
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    disabled={!isVaultUnlocked}
                    onClick={() => {
                      setUploadOpen((current) => {
                        const nextOpen = !current;
                        if (nextOpen) setEditing(false);
                        return nextOpen;
                      });
                    }}
                    className="w-full justify-center"
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {uploadOpen ? "Close upload" : "Upload"}
                  </Button>
                  <Button
                    asChild
                    variant="none"
                    effect="fade"
                    size="sm"
                    className="w-full justify-center"
                  >
                    <a href="/templates/ria-picks-template.csv" download>
                      <Download className="mr-2 h-4 w-4" />
                      Template
                    </a>
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:mx-auto xl:max-w-[28rem]">
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="sm"
                    disabled={savingToMyList || kaiLoading || !isVaultUnlocked}
                    onClick={() => void saveKaiAsMyList()}
                    className="w-full justify-center"
                  >
                    <Save className="mr-2 h-4 w-4" />
                    {savingToMyList ? "Copying..." : "Copy from Kai"}
                  </Button>
                  {!editing ? (
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      disabled={!isVaultUnlocked}
                      onClick={startEditing}
                      className="w-full justify-center"
                    >
                      <PencilLine className="mr-2 h-4 w-4" />
                      Edit
                    </Button>
                  ) : (
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      disabled={!isVaultUnlocked}
                      onClick={discardChanges}
                      className="w-full justify-center"
                    >
                      <X className="mr-2 h-4 w-4" />
                      Discard
                    </Button>
                  )}
                </div>
                {!isVaultUnlocked ? (
                  <p className="px-1 text-center text-xs text-muted-foreground">
                    Unlock the vault to edit or publish your advisor package.
                  </p>
                ) : null}
              </SurfaceCardContent>
            </SurfaceCard>
          ) : null}

          {iamUnavailable ? (
            <RiaCompatibilityState
              title="Waiting on IAM schema"
              description="Pick lists need the IAM tables."
            />
          ) : null}

          {!iamUnavailable && source === "my" && uploadOpen ? (
            <UploadPanel
              label={label}
              fileName={fileName}
              fileContent={fileContent}
              submitting={submitting}
              onLabelChange={setLabel}
              onFileSelected={(file) => {
                if (!file) {
                  setFileName("");
                  setFileContent("");
                  return;
                }
                setFileName(file.name);
                void file.text().then(setFileContent);
              }}
              onUpload={() => void onUpload()}
            />
          ) : null}

          {!iamUnavailable && editing && source === "my" ? (
            <InlineValidationBanner errors={validationState.packageErrors} />
          ) : null}

          {!iamUnavailable && editing && source === "my" ? (
            <ValidationIssuesPanel
              issues={validationIssues}
              showIssuesOnly={showIssuesOnly}
              onToggleShowIssuesOnly={() => setShowIssuesOnly((current) => !current)}
              onJumpToIssue={(issue) => {
                setCategory(issue.category);
                setShowIssuesOnly(true);
                setFocusedIssueRowId(issue.rowId);
              }}
            />
          ) : null}

          {!iamUnavailable && category === "top-picks" ? (
            <div className="space-y-4">
              <TierSummary rows={source === "kai" ? kaiRows : myTopPicks} />

              {source === "kai" && kaiLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading Kai list...
                </div>
              ) : null}

              {source === "my" && picksResource.loading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading My list...
                </div>
              ) : null}

              {myListRequiresUnlock ? (
                <SurfaceCard>
                  <SurfaceCardContent className="p-4 sm:p-5">
                    <p className="text-sm font-medium text-foreground">Unlock required</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      This advisor package is now stored in your PKM. Unlock the vault to view or edit it.
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
              ) : null}

              {showMyListEmptyState ? (
                <EmptyMyListState />
              ) : null}

              {source === "my" && editing && draftPackage ? (
                <TopPicksEditor
                  rows={draftPackage.top_picks}
                  errors={validationState.rowErrors}
                  showIssuesOnly={showIssuesOnly}
                  focusedRowId={focusedIssueRowId}
                  packageSaving={packageSaving}
                  saveDisabled={!hasUnsavedChanges}
                  onAddRow={() =>
                    updateDraft({
                      ...draftPackage,
                      top_picks: [...draftPackage.top_picks, createTopPickRow()],
                    })
                  }
                  onRemoveRow={(id) =>
                    updateDraft({
                      ...draftPackage,
                      top_picks: draftPackage.top_picks.filter((row) => row.id !== id),
                    })
                  }
                  onRowChange={patchTopPickRow}
                  onTickerResolved={updateTopPickTicker}
                  onSave={() => void saveDraftPackage()}
                />
              ) : null}

              {((source === "kai" && !kaiLoading && kaiRows.length > 0) ||
                (source === "my" && !editing && !picksResource.loading && myTopPicks.length > 0)) ? (
                <div data-testid="ria-picks-active">
                  <DataTable
                    columns={pickColumns}
                    data={source === "kai" ? kaiRows : myTopPicks}
                    searchKey="ticker"
                    globalSearchKeys={["ticker", "company_name", "sector", "tier", "investment_thesis"]}
                    searchPlaceholder={`Search ${sourceTitle.toLowerCase()} by ticker, company, sector, or tier`}
                    initialPageSize={10}
                    pageSizeOptions={[10, 20, 30]}
                    density="compact"
                    stickyHeader
                    tableContainerClassName="w-full"
                    tableClassName="w-full min-w-[640px]"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {!iamUnavailable && category === "avoid" ? (
            <div className="space-y-4">
              {source === "kai" && avoidLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading avoid list...
                </div>
              ) : null}

              {source === "my" && editing && draftPackage ? (
                <AvoidEditor
                  rows={draftPackage.avoid_rows}
                  errors={validationState.rowErrors}
                  showIssuesOnly={showIssuesOnly}
                  focusedRowId={focusedIssueRowId}
                  categoryOptions={avoidCategoryOptions}
                  packageSaving={packageSaving}
                  saveDisabled={!hasUnsavedChanges}
                  onAddRow={() =>
                    updateDraft({
                      ...draftPackage,
                      avoid_rows: [...draftPackage.avoid_rows, createAvoidRow()],
                    })
                  }
                  onRemoveRow={(id) =>
                    updateDraft({
                      ...draftPackage,
                      avoid_rows: draftPackage.avoid_rows.filter((row) => row.id !== id),
                    })
                  }
                  onRowChange={patchAvoidRow}
                  onTickerResolved={updateAvoidTicker}
                  onSave={() => void saveDraftPackage()}
                />
              ) : null}

              {source === "my" && !editing && myAvoidRows.length === 0 ? (
                <SurfaceCard>
                  <SurfaceCardContent className="p-5">
                    <p className="text-sm font-semibold text-foreground">Avoid list is empty</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Add names you want Kai to treat as hard or soft exclusions before the linked
                      investor debate begins.
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
              ) : null}

              {((source === "kai" && !avoidLoading && avoidRows.length > 0) ||
                (source === "my" && !editing && myAvoidRows.length > 0)) ? (
                <div data-testid="ria-picks-active">
                  <DataTable
                    columns={avoidColumns}
                    data={source === "kai" ? avoidRows : myAvoidRows}
                    searchKey="ticker"
                    globalSearchKeys={["ticker", "company_name", "sector", "category", "why_avoid", "note"]}
                    searchPlaceholder="Search avoid list by ticker, company, category, or reason"
                    initialPageSize={10}
                    pageSizeOptions={[10, 20, 30]}
                    density="compact"
                    stickyHeader
                    tableContainerClassName="w-full"
                    tableClassName="w-full min-w-[700px]"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {!iamUnavailable && category === "screening" ? (
            <div className="space-y-4">
              {source === "kai" && screeningLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading screening criteria...
                </div>
              ) : null}

              {source === "my" && editing && draftPackage ? (
                <ScreeningEditor
                  sections={draftPackage.screening_sections}
                  errors={validationState.rowErrors}
                  showIssuesOnly={showIssuesOnly}
                  focusedRowId={focusedIssueRowId}
                  packageSaving={packageSaving}
                  saveDisabled={!hasUnsavedChanges}
                  onAddRow={(section) =>
                    updateDraft({
                      ...draftPackage,
                      screening_sections: draftPackage.screening_sections.map((item) =>
                        item.section === section
                          ? { ...item, rows: [...item.rows, createScreeningRow()] }
                          : item
                      ),
                    })
                  }
                  onRemoveRow={(section, rowId) =>
                    updateDraft({
                      ...draftPackage,
                      screening_sections: draftPackage.screening_sections.map((item) =>
                        item.section === section
                          ? { ...item, rows: item.rows.filter((row) => row.id !== rowId) }
                          : item
                      ),
                    })
                  }
                  onRowChange={patchScreeningRow}
                  onSave={() => void saveDraftPackage()}
                />
              ) : null}

              {!editing ? (
                <div className="space-y-6" data-testid="ria-picks-active">
                  {screeningViewRows.map((section) => (
                    <SurfaceCard key={section.section}>
                      <SurfaceCardContent className="p-4">
                        <h3 className="mb-3 text-sm font-semibold text-foreground">{section.label}</h3>
                        {section.rows.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No rules yet for this section.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {section.rows.map((rule, index) => (
                              <div
                                key={`${section.section}-${index}`}
                                className="border-b border-border/20 pb-2 last:border-0 last:pb-0"
                              >
                                <p className="text-sm font-medium text-foreground">{rule.title}</p>
                                {shouldRenderScreeningDetail(rule) ? (
                                  <p className="text-xs leading-5 text-muted-foreground">
                                    {rule.detail}
                                  </p>
                                ) : null}
                                {shouldRenderScreeningValue(rule) ? (
                                  <p className="mt-1 text-xs font-medium text-primary">
                                    {rule.value_text}
                                  </p>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}
                      </SurfaceCardContent>
                    </SurfaceCard>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
