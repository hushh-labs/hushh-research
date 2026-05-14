"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Cloud, Cpu, Download, HardDrive, Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  localRuntimeService,
  type LocalRuntimeReadiness,
  type ModelPackManifest,
  type ProcessingMode,
} from "@/lib/ai/local-runtime-service";
import { packDownloadManager, type PackInstallStatus } from "@/lib/ai/pack-download-manager";
import { cn } from "@/lib/utils";

type SettingsState = {
  mode: ProcessingMode;
  manifest: ModelPackManifest | null;
  readiness: LocalRuntimeReadiness | null;
  installStatus: PackInstallStatus;
  warning: string | null;
  error: string | null;
};

const INITIAL_STATE: SettingsState = {
  mode: "cloud",
  manifest: null,
  readiness: null,
  installStatus: { state: "not_installed", progressPct: 0 },
  warning: null,
  error: null,
};

function formatStorage(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unknown";
  return `${Math.round(value)} MB`;
}

function statusLabel(status: PackInstallStatus): string {
  if (status.state === "installed") return "Installed";
  if (status.state === "downloading") return `Downloading ${status.progressPct}%`;
  return "Not installed";
}

export function OnDeviceAISettings({ className }: { className?: string }) {
  const [state, setState] = useState<SettingsState>(INITIAL_STATE);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [mode, capability, installStatus] = await Promise.all([
        localRuntimeService.getProcessingMode(),
        packDownloadManager.fetchCapability(),
        packDownloadManager.getInstallStatus(),
      ]);
      const manifest = capability.installed_packs[0] || null;
      const readiness = manifest
        ? await localRuntimeService.getDeviceReadiness(manifest)
        : null;
      setState({
        mode,
        manifest,
        readiness,
        installStatus,
        warning: readiness?.lowStorage ? "Storage is tight for this pack." : null,
        error: null,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Could not load on-device AI status.",
      }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const downloadDisabled = useMemo(() => {
    if (downloading || loading) return true;
    if (!state.manifest || !state.readiness) return true;
    if (state.installStatus.state === "installed") return true;
    return !state.readiness.meetsRam || !state.readiness.meetsStorage;
  }, [downloading, loading, state.installStatus.state, state.manifest, state.readiness]);

  const onModeChange = async (value: string) => {
    const next = value as ProcessingMode;
    const mode = await localRuntimeService.setProcessingMode(next);
    setState((current) => ({ ...current, mode }));
  };

  const onDownload = async () => {
    if (!state.manifest) return;
    setDownloading(true);
    setState((current) => ({
      ...current,
      installStatus: { state: "downloading", progressPct: 0 },
      error: null,
    }));
    try {
      await packDownloadManager.downloadPack(state.manifest, (progressPct) => {
        setState((current) => ({
          ...current,
          installStatus: { state: "downloading", progressPct },
        }));
      });
      await refresh();
    } catch (error) {
      setState((current) => ({
        ...current,
        installStatus: { state: "not_installed", progressPct: 0 },
        error: error instanceof Error ? error.message : "AI pack download failed.",
      }));
    } finally {
      setDownloading(false);
    }
  };

  const installed = state.installStatus.state === "installed";
  const staleContextWarning = state.mode === "on_device" && installed;

  return (
    <section
      className={cn(
        "w-full space-y-4 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Cpu className="h-4 w-4" />
            On-device AI
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Optional local OCR, speech, voice, and small-model inference.
          </p>
        </div>
        <Select value={state.mode} onValueChange={onModeChange} disabled={!installed}>
          <SelectTrigger className="w-[144px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cloud">Cloud</SelectItem>
            <SelectItem value="hybrid">Hybrid</SelectItem>
            <SelectItem value="on_device">On device</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {state.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {state.warning ? (
        <Alert>
          <HardDrive className="h-4 w-4" />
          <AlertDescription>{state.warning}</AlertDescription>
        </Alert>
      ) : null}

      {staleContextWarning ? (
        <Alert>
          <Cloud className="h-4 w-4" />
          <AlertDescription>Context may be outdated while fully offline.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-md border border-border/70 p-3">
          <div className="text-xs text-muted-foreground">Pack</div>
          <div className="font-medium">{statusLabel(state.installStatus)}</div>
        </div>
        <div className="rounded-md border border-border/70 p-3">
          <div className="text-xs text-muted-foreground">RAM</div>
          <div className="font-medium">
            {state.readiness?.detectedRamGb ? `${state.readiness.detectedRamGb.toFixed(1)} GB` : "Unknown"}
          </div>
        </div>
        <div className="rounded-md border border-border/70 p-3">
          <div className="text-xs text-muted-foreground">Storage</div>
          <div className="font-medium">{formatStorage(state.readiness?.availableStorageMb)}</div>
        </div>
      </div>

      {state.installStatus.state === "downloading" ? (
        <Progress value={state.installStatus.progressPct} className="h-2" />
      ) : null}

      <Button onClick={() => void onDownload()} disabled={downloadDisabled} className="w-full sm:w-auto">
        {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Download AI Pack
      </Button>
    </section>
  );
}
