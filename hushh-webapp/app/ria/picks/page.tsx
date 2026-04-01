"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Crown,
  Download,
  FileSpreadsheet,
  Loader2,
  Medal,
  Search,
  Star,
  Trophy,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsSegmentedTabs } from "@/components/profile/settings-ui";
import { RiaCompatibilityState } from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import {
  isIAMSchemaNotReadyError,
  RiaService,
  type RiaPickRow,
  type RiaPickUploadRecord,
} from "@/lib/services/ria-service";
import { cn } from "@/lib/utils";

const TIER_CONFIG: Record<string, { icon: typeof Crown; color: string; label: string }> = {
  ACE: { icon: Crown, color: "text-fuchsia-600 dark:text-fuchsia-400", label: "ACE" },
  KING: { icon: Trophy, color: "text-amber-600 dark:text-amber-400", label: "KING" },
  QUEEN: { icon: Star, color: "text-violet-600 dark:text-violet-400", label: "QUEEN" },
  JACK: { icon: Medal, color: "text-sky-600 dark:text-sky-400", label: "JACK" },
};

function TierBadge({ tier }: { tier?: string | null }) {
  const normalized = String(tier || "").toUpperCase();
  const config = TIER_CONFIG[normalized];
  if (!config) return <Badge variant="secondary" className="text-[10px]">{tier || "—"}</Badge>;
  const Icon = config.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", config.color)}>
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  );
}

export default function RiaPicksPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { riaCapability, loading: personaLoading, refreshing: personaRefreshing } = usePersonaState();

  const [tab, setTab] = useState<"active" | "upload">("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [label, setLabel] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const picksResource = useStaleResource<{
    items: RiaPickUploadRecord[];
    active_rows: RiaPickRow[];
  }>({
    cacheKey: user?.uid ? `ria_picks_${user.uid}` : "ria_picks_guest",
    enabled: Boolean(user?.uid && (riaCapability !== "setup" || personaRefreshing)),
    load: async () => {
      if (!user?.uid) throw new Error("Sign in to manage picks");
      const idToken = await user.getIdToken();
      return RiaService.listPicks(idToken, { userId: user.uid });
    },
  });

  const activeRows = picksResource.data?.active_rows || [];
  const loading = picksResource.loading;
  const error = picksResource.error;
  const iamUnavailable = Boolean(error && isIAMSchemaNotReadyError(new Error(error)));

  useEffect(() => {
    if (!personaLoading && !personaRefreshing && riaCapability === "setup") {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [personaLoading, personaRefreshing, riaCapability, router]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return activeRows;
    return activeRows.filter(
      (r) =>
        r.ticker.toLowerCase().includes(q) ||
        (r.company_name || "").toLowerCase().includes(q) ||
        (r.sector || "").toLowerCase().includes(q) ||
        (r.tier || "").toLowerCase().includes(q)
    );
  }, [activeRows, searchQuery]);

  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of activeRows) {
      const tier = String(row.tier || "OTHER").toUpperCase();
      counts[tier] = (counts[tier] || 0) + 1;
    }
    return counts;
  }, [activeRows]);

  async function onUpload() {
    if (!user || !fileContent.trim()) return;
    try {
      setSubmitting(true);
      const idToken = await user.getIdToken();
      await RiaService.uploadPicks(idToken, {
        csv_content: fileContent,
        source_filename: fileName || undefined,
        label: label.trim() || undefined,
      });
      toast.success("Picks uploaded", { description: "Active list updated." });
      setLabel("");
      setFileName("");
      setFileContent("");
      setTab("active");
      void picksResource.refresh({ force: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (personaLoading) return null;
  if (riaCapability === "setup") {
    return <RiaCompatibilityState title="Complete RIA onboarding" description="Finish onboarding to manage picks." />;
  }

  return (
    <AppPageShell as="main" width="wide" className="pb-28">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Picks"
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Advisor picks
              {activeRows.length > 0 ? (
                <Badge variant="secondary" className="text-[10px]">{activeRows.length}</Badge>
              ) : null}
            </span>
          }
          description="Your active stock picks list. Investors see these in their Kai market view."
          icon={FileSpreadsheet}
          accent="emerald"
          actions={
            <Button asChild variant="none" effect="fade" size="sm">
              <a href="/templates/ria-picks-template.csv" download>
                <Download className="mr-2 h-4 w-4" />
                Template
              </a>
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div className="flex flex-col gap-6">
          <SettingsSegmentedTabs
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            options={[
              { value: "active", label: `Active list (${activeRows.length})` },
              { value: "upload", label: "Upload new" },
            ]}
          />

          {iamUnavailable ? (
            <RiaCompatibilityState
              title="Waiting on IAM schema"
              description="Pick lists need the IAM tables before they can activate."
            />
          ) : null}

          {/* ── Active List Tab ── */}
          {!iamUnavailable && tab === "active" ? (
            <div className="space-y-4">
              {/* Tier summary */}
              {activeRows.length > 0 ? (
                <div className="flex flex-wrap gap-3">
                  {Object.entries(TIER_CONFIG).map(([tier, config]) => {
                    const count = tierCounts[tier] || 0;
                    if (count === 0) return null;
                    const Icon = config.icon;
                    return (
                      <div key={tier} className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-card px-3 py-2 shadow-[var(--app-card-shadow-standard)]">
                        <Icon className={cn("h-4 w-4", config.color)} />
                        <span className="text-sm font-semibold text-foreground">{count}</span>
                        <span className="text-xs text-muted-foreground">{tier}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* Search */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by ticker, company, sector, or tier"
                  className="min-h-10 border-0 bg-card pl-10 shadow-[var(--app-card-shadow-standard)]"
                />
              </div>

              {/* Table */}
              {loading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading picks...
                </div>
              ) : filteredRows.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {activeRows.length === 0
                    ? "No picks yet. Upload a CSV or use Kai defaults to get started."
                    : "No matches for this search."}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-[var(--radius-md)] bg-card shadow-[var(--app-card-shadow-standard)]">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3">Ticker</th>
                        <th className="px-4 py-3">Company</th>
                        <th className="hidden px-4 py-3 sm:table-cell">Sector</th>
                        <th className="px-4 py-3">Tier</th>
                        <th className="hidden px-4 py-3 md:table-cell">Thesis</th>
                        <th className="hidden px-4 py-3 lg:table-cell">FCF</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                      {filteredRows.map((row, i) => (
                        <tr
                          key={`${row.ticker}-${i}`}
                          className="transition-colors hover:bg-muted/30"
                        >
                          <td className="px-4 py-3 font-semibold text-foreground">{row.ticker}</td>
                          <td className="px-4 py-3 text-muted-foreground">{row.company_name || "—"}</td>
                          <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{row.sector || "—"}</td>
                          <td className="px-4 py-3"><TierBadge tier={row.tier} /></td>
                          <td className="hidden max-w-xs truncate px-4 py-3 text-xs text-muted-foreground md:table-cell">{row.investment_thesis || "—"}</td>
                          <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                            {row.fcf_billions != null ? `$${row.fcf_billions}B` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {/* ── Upload Tab ── */}
          {!iamUnavailable && tab === "upload" ? (
            <div className="mx-auto w-full max-w-lg space-y-4">
              <div className="rounded-[var(--radius-md)] bg-card p-5 shadow-[var(--app-card-shadow-standard)]">
                <h3 className="text-sm font-semibold text-foreground">Upload a new picks list</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  The new list replaces the current active picks. Previous versions stay in history.
                </p>
                <div className="mt-4 space-y-3">
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Label, e.g. Q2 growth rotation"
                  />
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setFileName(file.name);
                        void file.text().then(setFileContent);
                      }
                    }}
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
                      onClick={() => void onUpload()}
                      disabled={submitting || !fileContent.trim()}
                    >
                      {submitting ? "Uploading..." : "Upload and activate"}
                    </Button>
                    <Button asChild variant="none" effect="fade" size="sm">
                      <a href="/templates/ria-picks-template.csv" download>
                        Download template CSV
                      </a>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
