"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Crown,
  Download,
  FileSpreadsheet,
  Loader2,
  Medal,
  Save,
  Search,
  ShieldAlert,
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

type PicksTab = "kai" | "my-picks" | "avoid" | "screening" | "upload";

const TIER_CONFIG: Record<string, { icon: typeof Crown; color: string }> = {
  ACE: { icon: Crown, color: "text-fuchsia-600 dark:text-fuchsia-400" },
  KING: { icon: Trophy, color: "text-amber-600 dark:text-amber-400" },
  QUEEN: { icon: Star, color: "text-violet-600 dark:text-violet-400" },
  JACK: { icon: Medal, color: "text-sky-600 dark:text-sky-400" },
};

function TierBadge({ tier }: { tier?: string | null }) {
  const t = String(tier || "").toUpperCase();
  const config = TIER_CONFIG[t];
  if (!config) return <span className="text-xs text-muted-foreground">{tier || "—"}</span>;
  const Icon = config.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", config.color)}>
      <Icon className="h-3.5 w-3.5" />
      {t}
    </span>
  );
}

function StockTable({ rows, searchQuery, showThesis = true }: { rows: RiaPickRow[]; searchQuery: string; showThesis?: boolean }) {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.ticker.toLowerCase().includes(q) ||
        (r.company_name || "").toLowerCase().includes(q) ||
        (r.sector || "").toLowerCase().includes(q) ||
        (r.tier || "").toLowerCase().includes(q)
    );
  }, [rows, searchQuery]);

  if (filtered.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {rows.length === 0 ? "No stocks in this list." : "No matches."}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] bg-card shadow-[var(--app-card-shadow-standard)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3">Ticker</th>
            <th className="px-4 py-3">Company</th>
            <th className="hidden px-4 py-3 sm:table-cell">Sector</th>
            <th className="px-4 py-3">Tier</th>
            {showThesis ? <th className="hidden px-4 py-3 md:table-cell">Thesis</th> : null}
            <th className="hidden px-4 py-3 lg:table-cell">FCF</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/20">
          {filtered.map((row, i) => (
            <tr key={`${row.ticker}-${i}`} className="transition-colors hover:bg-muted/30">
              <td className="px-4 py-3 font-semibold text-foreground">{row.ticker}</td>
              <td className="px-4 py-3 text-muted-foreground">{row.company_name || "—"}</td>
              <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{row.sector || "—"}</td>
              <td className="px-4 py-3"><TierBadge tier={row.tier} /></td>
              {showThesis ? (
                <td className="hidden max-w-xs truncate px-4 py-3 text-xs text-muted-foreground md:table-cell">
                  {row.investment_thesis || "—"}
                </td>
              ) : null}
              <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                {row.fcf_billions != null ? `$${row.fcf_billions}B` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RiaPicksPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { riaCapability, loading: personaLoading, refreshing: personaRefreshing } = usePersonaState();

  const [tab, setTab] = useState<PicksTab>("kai");
  const [searchQuery, setSearchQuery] = useState("");
  const [label, setLabel] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [savingToMyList, setSavingToMyList] = useState(false);

  // Kai default universe
  const [kaiRows, setKaiRows] = useState<RiaPickRow[]>([]);
  const [kaiLoading, setKaiLoading] = useState(false);

  // Avoid list
  const [avoidRows, setAvoidRows] = useState<Array<{ ticker: string; company_name?: string; sector?: string; category?: string; why_avoid?: string }>>([]);
  const [avoidLoading, setAvoidLoading] = useState(false);

  // Screening criteria
  const [screeningRows, setScreeningRows] = useState<Array<{ section: string; title: string; detail: string; value_text?: string }>>([]);
  const [screeningLoading, setScreeningLoading] = useState(false);

  // My picks (RIA uploaded)
  const picksResource = useStaleResource<{ items: RiaPickUploadRecord[]; active_rows: RiaPickRow[] }>({
    cacheKey: user?.uid ? `ria_picks_${user.uid}` : "ria_picks_guest",
    enabled: Boolean(user?.uid && (riaCapability !== "setup" || personaRefreshing)),
    load: async () => {
      if (!user?.uid) throw new Error("Sign in");
      const idToken = await user.getIdToken();
      return RiaService.listPicks(idToken, { userId: user.uid });
    },
  });

  const myRows = picksResource.data?.active_rows || [];
  const iamUnavailable = Boolean(picksResource.error && isIAMSchemaNotReadyError(new Error(picksResource.error)));

  useEffect(() => {
    if (!personaLoading && !personaRefreshing && riaCapability === "setup") {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [personaLoading, personaRefreshing, riaCapability, router]);

  // Load Kai universe on tab switch
  useEffect(() => {
    if (tab !== "kai" || !user || kaiRows.length > 0) return;
    let cancelled = false;
    void (async () => {
      setKaiLoading(true);
      try {
        const idToken = await user.getIdToken();
        const data = await RiaService.getRenaissanceUniverse(idToken);
        if (!cancelled) setKaiRows(data.items);
      } catch { /* ignore */ }
      finally { if (!cancelled) setKaiLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tab, user, kaiRows.length]);

  // Load avoid list on tab switch
  useEffect(() => {
    if (tab !== "avoid" || !user || avoidRows.length > 0) return;
    let cancelled = false;
    void (async () => {
      setAvoidLoading(true);
      try {
        const idToken = await user.getIdToken();
        const data = await RiaService.getRenaissanceAvoid(idToken);
        if (!cancelled) setAvoidRows(data.items);
      } catch { /* ignore */ }
      finally { if (!cancelled) setAvoidLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tab, user, avoidRows.length]);

  // Load screening on tab switch
  useEffect(() => {
    if (tab !== "screening" || !user || screeningRows.length > 0) return;
    let cancelled = false;
    void (async () => {
      setScreeningLoading(true);
      try {
        const idToken = await user.getIdToken();
        const data = await RiaService.getRenaissanceScreening(idToken);
        if (!cancelled) setScreeningRows(data.items);
      } catch { /* ignore */ }
      finally { if (!cancelled) setScreeningLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tab, user, screeningRows.length]);

  const tierCounts = useMemo(() => {
    const rows = tab === "kai" ? kaiRows : myRows;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.tier || "OTHER").toUpperCase()] = (counts[String(row.tier || "OTHER").toUpperCase()] || 0) + 1;
    return counts;
  }, [tab, kaiRows, myRows]);

  async function saveKaiAsMyList() {
    if (!user || kaiRows.length === 0) return;
    try {
      setSavingToMyList(true);
      const csv = [
        "ticker,company_name,sector,tier,investment_thesis,tier_rank,conviction_weight,fcf_billions",
        ...kaiRows.map((r) =>
          [
            r.ticker,
            `"${(r.company_name || "").replace(/"/g, '""')}"`,
            r.sector || "",
            r.tier || "",
            `"${(r.investment_thesis || "").replace(/"/g, '""')}"`,
            r.tier_rank ?? "",
            r.conviction_weight ?? "",
            r.fcf_billions ?? "",
          ].join(",")
        ),
      ].join("\n");
      const idToken = await user.getIdToken();
      await RiaService.uploadPicks(idToken, {
        csv_content: csv,
        source_filename: "kai-renaissance-universe.csv",
        label: "Kai Renaissance Universe (snapshot)",
      });
      toast.success("Saved as your active picks list");
      void picksResource.refresh({ force: true });
      setTab("my-picks");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingToMyList(false);
    }
  }

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
      toast.success("Picks uploaded");
      setLabel(""); setFileName(""); setFileContent("");
      setTab("my-picks");
      void picksResource.refresh({ force: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (personaLoading) return null;
  if (riaCapability === "setup") return <RiaCompatibilityState title="Complete RIA onboarding" description="Finish onboarding to manage picks." />;

  return (
    <AppPageShell as="main" width="wide" className="pb-28">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Picks"
          title="Stock universe"
          description="Kai's Renaissance universe is the default. Save a snapshot as your own list, upload a custom CSV, or browse the screening criteria."
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
            onValueChange={(v) => { setTab(v as PicksTab); setSearchQuery(""); }}
            options={[
              { value: "kai", label: `Kai defaults (${kaiRows.length || "..."})` },
              { value: "my-picks", label: `My picks (${myRows.length})` },
              { value: "avoid", label: "Avoid list" },
              { value: "screening", label: "Screening" },
              { value: "upload", label: "Upload" },
            ]}
            mobileColumns={3}
          />

          {iamUnavailable ? (
            <RiaCompatibilityState title="Waiting on IAM schema" description="Pick lists need the IAM tables." />
          ) : null}

          {/* ── Kai defaults + My picks: shared table layout ── */}
          {!iamUnavailable && (tab === "kai" || tab === "my-picks") ? (
            <div className="space-y-4">
              {/* Tier chips */}
              {Object.keys(tierCounts).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(TIER_CONFIG).map(([tier, config]) => {
                    const count = tierCounts[tier] || 0;
                    if (count === 0) return null;
                    const Icon = config.icon;
                    return (
                      <div key={tier} className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-card px-3 py-1.5 text-sm shadow-[var(--app-card-shadow-standard)]">
                        <Icon className={cn("h-3.5 w-3.5", config.color)} />
                        <span className="font-semibold text-foreground">{count}</span>
                        <span className="text-xs text-muted-foreground">{tier}</span>
                      </div>
                    );
                  })}
                  {tab === "kai" ? (
                    <Button
                      variant="blue-gradient"
                      effect="fill"
                      size="sm"
                      disabled={savingToMyList || kaiRows.length === 0}
                      onClick={() => void saveKaiAsMyList()}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      {savingToMyList ? "Saving..." : "Save to my list"}
                    </Button>
                  ) : null}
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
              {(tab === "kai" && kaiLoading) || (tab === "my-picks" && picksResource.loading) ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading...
                </div>
              ) : (
                <StockTable
                  rows={tab === "kai" ? kaiRows : myRows}
                  searchQuery={searchQuery}
                />
              )}
            </div>
          ) : null}

          {/* ── Avoid list ── */}
          {!iamUnavailable && tab === "avoid" ? (
            <div className="space-y-4">
              {avoidLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading avoid list...
                </div>
              ) : avoidRows.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No stocks on the avoid list.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-[var(--radius-md)] bg-card shadow-[var(--app-card-shadow-standard)]">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3">Ticker</th>
                        <th className="px-4 py-3">Company</th>
                        <th className="hidden px-4 py-3 sm:table-cell">Sector</th>
                        <th className="hidden px-4 py-3 md:table-cell">Category</th>
                        <th className="hidden px-4 py-3 lg:table-cell">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                      {avoidRows.map((row, i) => (
                        <tr key={`${row.ticker}-${i}`} className="transition-colors hover:bg-muted/30">
                          <td className="px-4 py-3 font-semibold text-foreground">{row.ticker}</td>
                          <td className="px-4 py-3 text-muted-foreground">{row.company_name || "—"}</td>
                          <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{row.sector || "—"}</td>
                          <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">{row.category || "—"}</td>
                          <td className="hidden max-w-sm truncate px-4 py-3 text-xs text-muted-foreground lg:table-cell">{row.why_avoid || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {/* ── Screening criteria ── */}
          {!iamUnavailable && tab === "screening" ? (
            <div className="space-y-4">
              {screeningLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading screening criteria...
                </div>
              ) : screeningRows.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No screening criteria available.
                </div>
              ) : (
                <div className="space-y-6">
                  {["investable_requirements", "automatic_avoid_triggers", "the_math"].map((section) => {
                    const sectionRows = screeningRows.filter((r) => r.section === section);
                    if (sectionRows.length === 0) return null;
                    const sectionLabel = section === "investable_requirements" ? "Investable requirements" : section === "automatic_avoid_triggers" ? "Automatic avoid triggers" : "The math";
                    return (
                      <div key={section} className="rounded-[var(--radius-md)] bg-card p-4 shadow-[var(--app-card-shadow-standard)]">
                        <h3 className="mb-3 text-sm font-semibold text-foreground">{sectionLabel}</h3>
                        <div className="space-y-2">
                          {sectionRows.map((rule, i) => (
                            <div key={i} className="border-b border-border/20 pb-2 last:border-0 last:pb-0">
                              <p className="text-sm font-medium text-foreground">{rule.title}</p>
                              <p className="text-xs text-muted-foreground">{rule.detail}</p>
                              {rule.value_text ? (
                                <p className="mt-1 text-xs font-medium text-primary">{rule.value_text}</p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* ── Upload tab ── */}
          {!iamUnavailable && tab === "upload" ? (
            <div className="mx-auto w-full max-w-lg">
              <div className="rounded-[var(--radius-md)] bg-card p-5 shadow-[var(--app-card-shadow-standard)]">
                <h3 className="text-sm font-semibold text-foreground">Upload a custom picks list</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Replaces your active list. Previous versions stay in history.
                </p>
                <div className="mt-4 space-y-3">
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Q2 growth rotation" />
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) { setFileName(file.name); void file.text().then(setFileContent); }
                    }}
                  />
                  {fileName ? <p className="text-xs text-muted-foreground">Ready: <span className="font-medium text-foreground">{fileName}</span></p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="blue-gradient" effect="fill" size="sm" onClick={() => void onUpload()} disabled={submitting || !fileContent.trim()}>
                      {submitting ? "Uploading..." : "Upload and activate"}
                    </Button>
                    <Button asChild variant="none" effect="fade" size="sm">
                      <a href="/templates/ria-picks-template.csv" download>Download template</a>
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
