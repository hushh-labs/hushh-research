// components/kai/views/portfolio-import-view.tsx

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Database, FileUp, Loader2 } from "@/components/icons";

import { AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { cn } from "@/lib/utils";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import { FinanceSourcePicker } from "@/components/kai/onboarding/finance-onboarding";

const PlaidIcon = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
    className={cn(className, "!h-4 !w-4")}
  >
    <path d="M4 10.4V20a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-9.6" />
    <path d="M14 10.4V20a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-9.6" />
    <path d="M9 3H5a1 1 0 0 0-1 1v2.6h6V4a1 1 0 0 0-1-1z" />
    <path d="M19 3h-4a1 1 0 0 0-1 1v2.6h6V4a1 1 0 0 0-1-1z" />
  </svg>
);

interface PortfolioImportViewProps {
  onFileSelect: (file: File) => void;
  onSkip: () => void;
  onPreloadSchema?: () => void;
  onConnectPlaid?: (environment?: string | null) => void;
  plaidConnectionError?: string | null;
  isUploading?: boolean;
  isSkippingSource?: boolean;
  isPreloadingSchema?: boolean;
  isConnectingPlaid?: boolean;
  plaidConfigured?: boolean;
  /** Local development can target Plaid sandbox without exposing environment controls in One. */
  plaidLocalDualEnvironmentEnabled?: boolean;
  /** Setup routes provide their own single terminal deferral action. */
  showSkip?: boolean;
  presentation?: "list" | "onboarding";
  onIntroductionBack?: () => void;
}

/**
 * The source picker renders animated cards during onboarding and a compact
 * list from Portfolio. Both surfaces dispatch through the same handlers.
 */
export function PortfolioImportView({
  onFileSelect,
  onSkip,
  onPreloadSchema,
  onConnectPlaid,
  plaidConnectionError,
  isUploading = false,
  isSkippingSource = false,
  isPreloadingSchema = false,
  isConnectingPlaid = false,
  plaidConfigured = true,
  plaidLocalDualEnvironmentEnabled = false,
  showSkip = true,
  presentation = "list",
  onIntroductionBack,
}: PortfolioImportViewProps) {
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    scrollAppToTop("auto");
  }, []);

  const isSupportedFile = useCallback((file: File) => {
    const validTypes = [
      "application/pdf",
      "text/csv",
      "application/vnd.ms-excel",
    ];
    return (
      validTypes.includes(file.type) ||
      file.name.toLowerCase().endsWith(".csv") ||
      file.name.toLowerCase().endsWith(".pdf")
    );
  }, []);

  const selectStatement = useCallback(
    (file: File) => {
      if (!isSupportedFile(file)) {
        setSelectionError("Choose a PDF or CSV statement.");
        return;
      }
      setSelectionError(null);
      onFileSelect(file);
    },
    [isSupportedFile, onFileSelect],
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        selectStatement(file);
      }
      event.currentTarget.value = "";
    },
    [selectStatement],
  );

  const handleConnectPlaid = useCallback(() => {
    if (
      !onConnectPlaid ||
      isUploading ||
      isPreloadingSchema ||
      isConnectingPlaid ||
      !plaidConfigured
    ) {
      return;
    }
    onConnectPlaid(plaidLocalDualEnvironmentEnabled ? "sandbox" : undefined);
  }, [
    isConnectingPlaid,
    isPreloadingSchema,
    isUploading,
    onConnectPlaid,
    plaidConfigured,
    plaidLocalDualEnvironmentEnabled,
  ]);

  const handlePreloadSchema = useCallback(() => {
    if (!onPreloadSchema || isUploading || isPreloadingSchema) {
      return;
    }
    onPreloadSchema();
  }, [isPreloadingSchema, isUploading, onPreloadSchema]);

  const isBusy = isUploading || isPreloadingSchema || isConnectingPlaid || isSkippingSource;

  if (presentation === "onboarding") {
    return <>
      <input ref={fileInputRef} type="file" accept=".csv,.pdf" onChange={handleFileChange}
        className="sr-only" disabled={isBusy} aria-label="Choose a PDF or CSV brokerage statement" />
      <FinanceSourcePicker onConnect={handleConnectPlaid} onStatement={() => fileInputRef.current?.click()}
        onSample={handlePreloadSchema} onSkip={onSkip} onBack={onIntroductionBack} busy={isBusy}
        plaidAvailable={Boolean(onConnectPlaid && plaidConfigured)} sampleAvailable={Boolean(onPreloadSchema)}
        status={isSkippingSource ? "Continuing…" : isConnectingPlaid ? "Opening Plaid…" : isPreloadingSchema ? "Loading sample…" : "Importing statement…"}
        error={selectionError ?? plaidConnectionError} />
    </>;
  }

  return (
    <div className={`app-type-compact ${finance.workspace} w-full pb-2`}>
      <AppPageContentRegion className="mx-auto max-w-lg space-y-4">
        <PageHeader title="Import portfolio" accent="neutral" className={finance.compactPageHeader} />
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.pdf"
          onChange={handleFileChange}
          className="sr-only"
          disabled={isBusy}
          aria-label="Choose a PDF or CSV brokerage statement"
        />

        <SettingsGroup
          embedded
          separatorInset
          rowSizing="uniform"
          testId="portfolio-import-source-options"
        >
        <SettingsRow
          icon={PlaidIcon as any}
          iconTone="blue"
          title={
            plaidConfigured
              ? isConnectingPlaid
                ? "Opening Plaid connection"
                : "Connect a bank or brokerage"
              : "Bank connection unavailable"
          }
          description={
            plaidConfigured
              ? "Read-only sync via Plaid"
              : "Use a statement instead"
          }
          onClick={handleConnectPlaid}
          disabled={!onConnectPlaid || !plaidConfigured || isBusy}
          chevron={!isConnectingPlaid && plaidConfigured}
          trailing={
            isConnectingPlaid ? (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="Opening brokerage connection"
              />
            ) : undefined
          }
          testId="portfolio-import-connect-brokerage"
        />
        <SettingsRow
          icon={FileUp}
          iconTone="accent"
          title={isUploading ? "Importing statement" : "Upload a statement"}
          description="PDF or CSV from your brokerage"
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy}
          chevron={!isUploading}
          trailing={
            isUploading ? (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="Importing statement"
              />
            ) : undefined
          }
          testId="portfolio-import-upload-statement"
        />
        {onPreloadSchema ? (
          <SettingsRow
            icon={Database}
            iconTone="purple"
            title={
              isPreloadingSchema
                ? "Loading sample brokerage"
                : "Try a sample portfolio"
            }
            description="Explore with demo holdings"
            onClick={handlePreloadSchema}
            disabled={isBusy}
            chevron={!isPreloadingSchema}
            trailing={
              isPreloadingSchema ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-label="Loading sample brokerage"
                />
              ) : undefined
            }
            testId="portfolio-import-load-sample"
          />
        ) : null}
        </SettingsGroup>

        {selectionError || plaidConnectionError ? (
          <p className="ui-text-row-description px-1 text-destructive" role="alert">
            {selectionError ?? plaidConnectionError}
          </p>
        ) : null}

        {showSkip ? (
          <div className="pt-0.5 text-center">
            <MorphyButton
              variant="none"
              effect="fade"
              onClick={onSkip}
              disabled={isBusy}
              className="ui-text-row-description min-h-11 rounded-full px-4 text-muted-foreground hover:text-foreground"
            >
              I&apos;ll link this later
            </MorphyButton>
          </div>
        ) : null}
      </AppPageContentRegion>
    </div>
  );
}
