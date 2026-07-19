// components/kai/views/portfolio-import-view.tsx

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Database, FileUp, Loader2 } from "lucide-react";

import { AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { KaiWorkspaceHeader } from "@/components/kai/kai-workspace-header";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { cn } from "@/lib/utils";

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
  isUploading?: boolean;
  isPreloadingSchema?: boolean;
  isConnectingPlaid?: boolean;
  plaidConfigured?: boolean;
  /** Local development can target Plaid sandbox without exposing environment controls in One. */
  plaidLocalDualEnvironmentEnabled?: boolean;
}

/**
 * A first-time portfolio source picker. This deliberately stays within the
 * shared reading measure: it is a short decision list, not a dashboard or
 * import workbench. Parsing and connection progress render after a choice.
 */
export function PortfolioImportView({
  onFileSelect,
  onSkip,
  onPreloadSchema,
  onConnectPlaid,
  isUploading = false,
  isPreloadingSchema = false,
  isConnectingPlaid = false,
  plaidConfigured = true,
  plaidLocalDualEnvironmentEnabled = false,
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

  const isBusy = isUploading || isPreloadingSchema || isConnectingPlaid;

  return (
    <div className="w-full pb-2">
      <KaiWorkspaceHeader
        workspace="portfolio"
        title="Portfolio"
        description="Choose how you want to begin."
      />

      <AppPageContentRegion className="space-y-3">
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
          testId="portfolio-import-source-options"
        >
        <SettingsRow
          icon={PlaidIcon as any}
          iconTone="blue"
          title={
            plaidConfigured
              ? isConnectingPlaid
                ? "Opening Plaid connection"
                : "Bank account (via Plaid)"
              : "Bank connection unavailable"
          }
          description={
            plaidConfigured
              ? "Read-only account sync"
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
                : "Load sample brokerage"
            }
            description="Explore Finance with sample holdings"
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

        {selectionError ? (
          <p className="px-1 text-sm text-destructive" role="alert">
            {selectionError}
          </p>
        ) : null}

        <div className="pt-0.5 text-center">
          <MorphyButton
            variant="none"
            effect="fade"
            onClick={onSkip}
            disabled={isBusy}
            className="h-10 rounded-full px-4 text-sm text-muted-foreground hover:text-foreground"
          >
            I&apos;ll link this later
          </MorphyButton>
        </div>
      </AppPageContentRegion>
    </div>
  );
}
