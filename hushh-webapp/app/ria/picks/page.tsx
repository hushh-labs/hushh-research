"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileSpreadsheet, Loader2, Upload, Waves } from "lucide-react";

import {
  RiaCompatibilityState,
  RiaPageShell,
  RiaStatusPanel,
  RiaSurface,
} from "@/components/ria/ria-page-shell";
import { SectionHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import {
  isIAMSchemaNotReadyError,
  RiaService,
  type RiaPickRow,
  type RiaPickUploadRecord,
} from "@/lib/services/ria-service";

function statusTone(status: string) {
  switch (status) {
    case "active":
      return "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-300";
    case "superseded":
      return "bg-sky-500/10 text-sky-700 border-sky-500/20 dark:text-sky-300";
    case "failed":
      return "bg-rose-500/10 text-rose-700 border-rose-500/20 dark:text-rose-300";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function formatDate(value?: string | null) {
  if (!value) return "Pending";
  return new Date(value).toLocaleString();
}

export default function RiaPicksPage() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    riaCapability,
    loading: personaLoading,
    refreshing: personaRefreshing,
  } = usePersonaState();
  const [label, setLabel] = useState("");
  const [fileName, setFileName] = useState<string>("");
  const [fileContent, setFileContent] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const picksResource = useStaleResource<{
    items: RiaPickUploadRecord[];
    active_rows: RiaPickRow[];
  }>({
    cacheKey: user?.uid ? `ria_picks_${user.uid}` : "ria_picks_guest",
    enabled: Boolean(user?.uid && (riaCapability !== "setup" || personaRefreshing)),
    load: async () => {
      if (!user?.uid) {
        throw new Error("Sign in to manage advisor picks");
      }
      const idToken = await user.getIdToken();
      return RiaService.listPicks(idToken, { userId: user.uid });
    },
  });

  const uploads = useMemo(() => picksResource.data?.items || [], [picksResource.data?.items]);
  const activeRows = picksResource.data?.active_rows || [];
  const loading = picksResource.loading;
  const error = picksResource.error;
  const iamUnavailable = Boolean(error && isIAMSchemaNotReadyError(new Error(error)));

  useEffect(() => {
    if (!personaLoading && !personaRefreshing && riaCapability === "setup") {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [personaLoading, personaRefreshing, riaCapability, router]);

  const activeUpload = useMemo(
    () => uploads.find((item) => item.status === "active") || uploads[0] || null,
    [uploads]
  );

  async function onFileSelected(file: File | null) {
    if (!file) {
      setFileName("");
      setFileContent("");
      return;
    }
    setFileName(file.name);
    setFileContent(await file.text());
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
      toast.success("RIA picks uploaded", {
        description: "The new upload is now the active picks list for this advisor.",
      });
      setLabel("");
      setFileName("");
      setFileContent("");
      await picksResource.refresh({ force: true });
    } catch (uploadError) {
      toast.error(uploadError instanceof Error ? uploadError.message : "Failed to upload picks");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RiaPageShell
      eyebrow="RIA Picks"
      title="Advisor picks feed"
      description="Keep one current investor-facing list live, keep prior uploads traceable, and avoid turning this into a reporting dashboard."
      icon={FileSpreadsheet}
      statusPanel={
        iamUnavailable ? null : (
          <RiaStatusPanel
            title="List state before row detail"
            description="Keep the active upload, history depth, and current row count visible before the advisor starts editing files or reviewing rows."
            dataTestId="ria-picks-primary"
            items={[
              {
                label: "Active upload",
                value: activeUpload?.label || "None yet",
                helper: activeUpload ? "Current investor-facing list" : "Upload a CSV to activate your first list",
                tone: activeUpload ? "success" : "neutral",
              },
              {
                label: "History",
                value: loading ? "..." : String(uploads.length),
                helper: "Uploads retained for traceability",
                tone: uploads.length > 1 ? "neutral" : "warning",
              },
              {
                label: "Active rows",
                value: loading ? "..." : String(activeRows.length),
                helper: "Rows exposed in the active advisor list",
                tone: activeRows.length > 0 ? "success" : "warning",
              },
              {
                label: "Template",
                value: "Renaissance CSV",
                helper: "Same schema as the default investor list",
                tone: "neutral",
              },
            ]}
          />
        )
      }
      actions={
        <Button asChild variant="none" effect="fade">
          <a href="/templates/ria-picks-template.csv" download>
            <Download className="mr-2 h-4 w-4" />
            Download template
          </a>
        </Button>
      }
    >
      {iamUnavailable ? (
        <RiaCompatibilityState
          title="RIA picks are waiting on the IAM rollout"
          description="The page is ready, but this environment still needs the IAM schema and pick-list tables before uploads can be activated."
        />
      ) : null}

      {!iamUnavailable ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <section className="space-y-3" data-testid="ria-picks-upload">
            <SectionHeader
              eyebrow="Upload"
              title="Drop in the next active picks list"
              description="Cached state stays visible while fresh upload history syncs quietly in the background."
              icon={Upload}
            />
            <RiaSurface className="space-y-4 p-4">
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Upload label, for example Q2 growth rotation"
              />
              <Input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void onFileSelected(event.target.files?.[0] || null)}
              />
              {fileName ? (
                <p className="text-sm text-muted-foreground">
                  Ready to upload: <span className="font-medium text-foreground">{fileName}</span>
                </p>
              ) : null}
              {error && !iamUnavailable ? <p className="text-sm text-red-500">{error}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  onClick={() => void onUpload()}
                  disabled={submitting || !fileContent.trim()}
                >
                  {submitting ? "Uploading..." : "Upload and activate"}
                </Button>
                <Button asChild variant="none" effect="fade">
                  <a href="/templates/ria-picks-template.csv" download>
                    Download sample CSV
                  </a>
                </Button>
              </div>
            </RiaSurface>
          </section>

          <section className="space-y-3">
            <SectionHeader
              eyebrow="Active list"
              title="What investors will compare against today"
              description="The active upload is the advisor list that later search and market comparisons can resolve for linked investors."
              icon={Waves}
            />
            <RiaSurface className="space-y-4 p-4" data-testid="ria-picks-active">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading picks...
                </div>
              ) : null}
              {!loading && picksResource.refreshing ? (
                <p className="text-xs text-muted-foreground">
                  Refreshing the active advisor feed in the background.
                </p>
              ) : null}
              {!loading && activeRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active rows yet. Upload a CSV using the template to populate the list.
                </p>
              ) : null}
              {!loading && activeRows.length > 0 ? (
                <SettingsGroup>
                  {activeRows.slice(0, 20).map((row) => (
                    <SettingsRow
                      key={`${row.ticker}-${row.company_name || "company"}`}
                      icon={FileSpreadsheet}
                      title={
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{row.ticker}</span>
                          {row.tier ? <Badge variant="outline">Tier {row.tier}</Badge> : null}
                          {row.recommendation_bias ? (
                            <Badge variant="secondary">{row.recommendation_bias}</Badge>
                          ) : null}
                        </div>
                      }
                      description={
                        row.investment_thesis ||
                        row.company_name ||
                        row.sector ||
                        "RIA active-list row"
                      }
                      trailing={
                        row.fcf_billions != null ? (
                          <Badge variant="outline">${row.fcf_billions}B FCF</Badge>
                        ) : undefined
                      }
                    />
                  ))}
                </SettingsGroup>
              ) : null}
            </RiaSurface>

            <SectionHeader
              eyebrow="Upload history"
              title="Previous list versions stay traceable"
              description="New uploads replace the active list, but older uploads remain in history so the advisor can audit what changed."
              icon={FileSpreadsheet}
            />
            <RiaSurface className="p-4" data-testid="ria-picks-history">
              <SettingsGroup>
                {uploads.map((upload) => (
                  <SettingsRow
                    key={upload.upload_id}
                    icon={upload.status === "active" ? Waves : FileSpreadsheet}
                    title={
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{upload.label}</span>
                        <Badge className={statusTone(upload.status)}>{upload.status}</Badge>
                      </div>
                    }
                    description={
                      upload.source_filename
                        ? `${upload.source_filename} · ${upload.row_count} rows`
                        : `${upload.row_count} rows`
                    }
                    trailing={
                      <span className="text-xs text-muted-foreground">
                        {formatDate(upload.created_at)}
                      </span>
                    }
                  />
                ))}
                {!loading && uploads.length === 0 ? (
                  <SettingsRow
                    icon={FileSpreadsheet}
                    title="No upload history yet"
                    description="Upload the first CSV to create an investor-facing picks feed."
                  />
                ) : null}
              </SettingsGroup>
            </RiaSurface>
          </section>
        </div>
      ) : null}
    </RiaPageShell>
  );
}
