"use client";

import { useCallback, useRef, useState } from "react";
import { ComputerUseTaskCard } from "@/components/computer-use/computer-use-task-card";
import type {
  ComputerUseBinding,
  ComputerUseSnapshot,
  ComputerUseTransport,
} from "@/lib/computer-use/contracts";
import { FilesService, type WikiArchiveImportResult } from "@/lib/files/service";
import { withUnlockedFilesConnection } from "@/lib/files/use-files-connection";
import {
  buildGuidedExportGoal,
  EXTERNAL_AI_EXPORT_PROVIDERS,
  type ExternalAiExportProvider,
  type GuidedAiExportPhase,
  reduceGuidedExportTerminalSnapshot,
  resolveGuidedBrowserEligibility,
} from "@/lib/files/wiki/guided-export";
import { Button } from "@/lib/morphy-ux/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ComputerUseClient } from "@/lib/services/computer-use-client";
import { nativeFeedbackToast as toast } from "@/lib/capacitor/native-feedback";

export type ExternalAiArchiveImportProps = {
  userId: string | null | undefined;
  isVaultUnlocked: boolean;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  owningRoute: string;
  onRequireVaultUnlock: () => void;
  onImported?: (result: WikiArchiveImportResult) => void;
};

export function ExternalAiArchiveImportSection({
  userId,
  isVaultUnlocked,
  vaultKey,
  vaultOwnerToken,
  owningRoute,
  onRequireVaultUnlock,
  onImported,
}: ExternalAiArchiveImportProps) {
  const [provider, setProvider] = useState<ExternalAiExportProvider>("chatgpt");
  const [phase, setPhase] = useState<GuidedAiExportPhase>("idle");
  const [fallbackNotice, setFallbackNotice] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [importReceipt, setImportReceipt] =
    useState<WikiArchiveImportResult | null>(null);
  const [browserTask, setBrowserTask] = useState<{
    binding: ComputerUseBinding;
    transport: ComputerUseTransport;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingFileRef = useRef<File | null>(null);

  useBackLayer(
    owningRoute,
    phase === "browser_active" || phase === "manual_steps" ? 2 : 0,
    () => {
      if (phase === "browser_active" || phase === "manual_steps") {
        setBrowserTask(null);
        setPhase("idle");
        return true;
      }
      return false;
    },
  );

  const importSavedFileId = useCallback(
    async (
      fileId: string,
      selectedProvider: ExternalAiExportProvider,
      signal: AbortSignal,
    ) => {
      if (!userId || !vaultKey || !vaultOwnerToken) {
        onRequireVaultUnlock();
        return;
      }
      setPhase("importing_archive");
      setErrorMessage("");
      try {
        const result = await withUnlockedFilesConnection(
          { userId, vaultKey, vaultOwnerToken, signal },
          () =>
            FilesService.wikiImportArchive(
              { fileId, sourceProvider: selectedProvider },
              signal,
            ),
        );
        setImportReceipt(result);
        setPhase("completed");
        onImported?.(result);
        toast.success(
          `Imported ${result.claimsImported} personal memory notes into your encrypted wiki.`,
        );
      } catch {
        setPhase("idle");
        setErrorMessage(
          "Couldn't import that archive. Check that it is a valid ChatGPT or Claude .zip or .json export.",
        );
        toast.error("Archive import couldn't complete.");
      }
    },
    [onImported, onRequireVaultUnlock, userId, vaultKey, vaultOwnerToken],
  );

  const handleUploadArchiveFile = useCallback(
    async (chosenFile: File) => {
      if (!userId) {
        toast.error("Sign in before importing an export archive.");
        return;
      }
      if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
        pendingFileRef.current = chosenFile;
        onRequireVaultUnlock();
        return;
      }
      const controller = new AbortController();
      setPhase("importing_archive");
      setErrorMessage("");
      try {
        const result = await withUnlockedFilesConnection(
          {
            userId,
            vaultKey,
            vaultOwnerToken,
            signal: controller.signal,
          },
          async () => {
            const uploaded = await FilesService.upload(
              chosenFile,
              "root",
              () => undefined,
              controller.signal,
            );
            return FilesService.wikiImportArchive(
              { fileId: uploaded.id, sourceProvider: provider },
              controller.signal,
            );
          },
        );
        pendingFileRef.current = null;
        setImportReceipt(result);
        setPhase("completed");
        onImported?.(result);
        toast.success(
          `Imported ${result.claimsImported} personal memory notes into your encrypted wiki.`,
        );
      } catch {
        setPhase("idle");
        setErrorMessage(
          "Couldn't upload or compile that archive. Ensure it is an unmodified .zip or .json export.",
        );
        toast.error("Couldn't import that export archive.");
      }
    },
    [
      isVaultUnlocked,
      onImported,
      onRequireVaultUnlock,
      provider,
      userId,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  const handleStartGuidedExport = useCallback(async () => {
    if (!userId) {
      toast.error("Sign in before starting a guided export.");
      return;
    }
    if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      onRequireVaultUnlock();
      return;
    }
    setPhase("checking_browser");
    setErrorMessage("");
    setFallbackNotice("");
    const controller = new AbortController();
    try {
      const client = new ComputerUseClient(userId, () => vaultOwnerToken);
      const capability = await client.capability(controller.signal);
      const eligibility = resolveGuidedBrowserEligibility(capability);
      if (!eligibility.eligible) {
        setFallbackNotice(eligibility.fallbackMessage);
        setPhase("manual_steps");
        return;
      }
      const descriptor = EXTERNAL_AI_EXPORT_PROVIDERS[provider];
      const snapshot = await client.start(
        {
          requestId: crypto.randomUUID(),
          goal: buildGuidedExportGoal(provider),
          allowedOrigins: [...descriptor.allowedOrigins],
        },
        controller.signal,
      );
      setBrowserTask({
        binding: snapshot.binding,
        transport: client.transport(),
      });
      setPhase("browser_active");
    } catch {
      setFallbackNotice(
        "Guided Browser export isn't available right now. Follow the steps below and upload your .zip or .json archive.",
      );
      setPhase("manual_steps");
    }
  }, [
    isVaultUnlocked,
    onRequireVaultUnlock,
    provider,
    userId,
    vaultKey,
    vaultOwnerToken,
  ]);

  const handleBrowserTerminalSnapshot = useCallback(
    (snapshot: ComputerUseSnapshot) => {
      setPhase((current) =>
        reduceGuidedExportTerminalSnapshot(current, snapshot),
      );
    },
    [],
  );

  const descriptor = EXTERNAL_AI_EXPORT_PROVIDERS[provider];

  return (
    <section
      aria-labelledby="archive-import-heading"
      className="space-y-3 rounded-[var(--app-radius-lg)] border border-border/60 bg-secondary/20 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="archive-import-heading"
          className="text-sm font-semibold text-foreground"
        >
          Full export archive (.zip or .json)
        </h2>
        <div
          className="inline-flex rounded-full border border-border/60 bg-background p-0.5 text-xs"
          role="group"
          aria-label="Export provider"
        >
          {(["chatgpt", "claude"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setProvider(option)}
              aria-pressed={provider === option}
              className={`rounded-full px-3 py-1 font-medium transition-colors ${
                provider === option
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {EXTERNAL_AI_EXPORT_PROVIDERS[option].label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Upload an exported {descriptor.label} archive directly into your
        encrypted Personal Wiki, or launch guided private-pod Browser export.
        Imported conversations stay untrusted evidence and candidate PKM details
        remain private until you confirm them.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        aria-label="Select ChatGPT or Claude export file"
        className="sr-only"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.currentTarget.value = "";
          if (chosen) {
            void handleUploadArchiveFile(chosen);
          }
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="plain"
          size="sm"
          className="border border-border/60 bg-background px-3.5"
          disabled={phase === "importing_archive" || phase === "checking_browser"}
          onClick={() => fileInputRef.current?.click()}
        >
          {phase === "importing_archive"
            ? "Importing archive…"
            : "Upload .zip / .json"}
        </Button>

        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={phase === "importing_archive" || phase === "checking_browser"}
          onClick={() => {
            void handleStartGuidedExport();
          }}
        >
          {phase === "checking_browser"
            ? "Checking Browser…"
            : `Guided ${descriptor.label} export`}
        </Button>
      </div>

      {phase === "browser_active" && browserTask ? (
        <div className="space-y-2 pt-1">
          <ComputerUseTaskCard
            binding={browserTask.binding}
            transport={browserTask.transport}
            route={owningRoute}
            onDownloadSaved={(saved) => {
              const controller = new AbortController();
              void importSavedFileId(saved.fileId, provider, controller.signal);
            }}
            onTerminalSnapshot={handleBrowserTerminalSnapshot}
          />
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
            onClick={() => setPhase("waiting_for_emailed_export")}
          >
            {descriptor.label} emailed my export link instead
          </button>
        </div>
      ) : null}

      {phase === "manual_steps" ? (
        <div className="space-y-2 rounded-[var(--app-radius-md)] border border-border/50 bg-background/80 p-3 text-xs">
          {fallbackNotice ? (
            <p className="text-muted-foreground" role="status">
              {fallbackNotice}
            </p>
          ) : null}
          <ol className="list-decimal space-y-1 pl-4 text-foreground">
            {descriptor.manualSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <button
            type="button"
            className="font-medium text-primary underline underline-offset-4"
            onClick={() => setPhase("waiting_for_emailed_export")}
          >
            I requested my export (waiting for email)
          </button>
        </div>
      ) : null}

      {phase === "waiting_for_emailed_export" ? (
        <div
          role="status"
          className="space-y-1.5 rounded-[var(--app-radius-md)] border border-border/60 bg-background p-3 text-xs"
        >
          <p className="font-semibold text-foreground">
            Waiting for emailed export archive
          </p>
          <p className="text-muted-foreground">
            {descriptor.label} prepares larger exports asynchronously by email.
            Upload the .zip here once it arrives, or continue setup and import
            anytime from Files → Personal Wiki.
          </p>
        </div>
      ) : null}

      {phase === "completed" && importReceipt ? (
        <div
          role="status"
          className="rounded-[var(--app-radius-md)] border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-foreground"
        >
          Imported {importReceipt.claimsImported} notes across{" "}
          {importReceipt.pagesUpdated} Personal Wiki{" "}
          {importReceipt.pagesUpdated === 1 ? "page" : "pages"}
          {importReceipt.candidateCount > 0
            ? ` (${importReceipt.candidateCount} candidate details held private for review).`
            : "."}
        </div>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
