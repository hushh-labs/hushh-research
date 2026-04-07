// components/kai/views/portfolio-import-view.tsx

/**
 * Portfolio Import View - Full-screen UI for uploading brokerage statements
 *
 * Features:
 * - Drag-and-drop zone for PDF/CSV files
 * - Supported brokerages list
 * - Skip option (minimal)
 */

"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";

import {
  Upload,
  FileText,
  CheckCircle,
  AlertCircle,
  Link2,
  Database,
  Loader2,
} from "lucide-react";
import { APP_MEASURE_STYLES } from "@/components/app-ui/app-page-shell";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { Icon } from "@/lib/morphy-ux/ui";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";

// =============================================================================
// TYPES
// =============================================================================

interface PortfolioImportViewProps {
  onFileSelect: (file: File) => void;
  onSkip: () => void;
  onPreloadSchema?: () => void;
  onConnectPlaid?: () => void;
  isUploading?: boolean;
  isPreloadingSchema?: boolean;
  isConnectingPlaid?: boolean;
  plaidConfigured?: boolean;
  plaidConnectedInstitutionCount?: number;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function PortfolioImportView({
  onFileSelect,
  onSkip,
  onPreloadSchema,
  onConnectPlaid,
  isUploading = false,
  isPreloadingSchema = false,
  isConnectingPlaid = false,
  plaidConfigured = true,
  plaidConnectedInstitutionCount = 0,
}: PortfolioImportViewProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    scrollAppToTop("auto");
  }, []);

  const isSupportedFile = useCallback((file: File) => {
    const validTypes = ["application/pdf", "text/csv", "application/vnd.ms-excel"];
    return validTypes.includes(file.type) || file.name.endsWith(".csv") || file.name.endsWith(".pdf");
  }, []);

  // Handle file drop
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      const file = files[0];

      if (file && isSupportedFile(file)) {
        setSelectedFile(file);
        setSelectionError(null);
        return;
      }
      setSelectionError("Please select a PDF or CSV statement.");
    },
    [isSupportedFile]
  );

  // Handle file input change
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files[0]) {
        const file = files[0];
        if (isSupportedFile(file)) {
          setSelectedFile(file);
          setSelectionError(null);
        } else {
          setSelectionError("Please select a PDF or CSV statement.");
        }
      }
      e.currentTarget.value = "";
    },
    [isSupportedFile]
  );

  // Handle drag over
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  // Handle drag leave
  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Trigger file input click
  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const handleContinue = useCallback(() => {
    if (!selectedFile || isUploading) return;
    onFileSelect(selectedFile);
  }, [selectedFile, isUploading, onFileSelect]);

  const handlePreloadSchema = useCallback(() => {
    if (!onPreloadSchema || isUploading || isPreloadingSchema) return;
    onPreloadSchema();
  }, [onPreloadSchema, isPreloadingSchema, isUploading]);

  const handleConnectPlaid = useCallback(() => {
    if (!onConnectPlaid || isUploading || isPreloadingSchema || isConnectingPlaid || plaidConfigured === false) {
      return;
    }
    onConnectPlaid();
  }, [
    isConnectingPlaid,
    isPreloadingSchema,
    isUploading,
    onConnectPlaid,
    plaidConfigured,
  ]);

  return (
    <div className="mx-auto w-full space-y-3.5 pt-3 pb-6" style={APP_MEASURE_STYLES.reading}>
      {/* Header */}
      <div className="space-y-2 text-center">
        <h1 className="text-[34px] font-bold tracking-tight leading-[1.08]">
          Your money
          <br />
          <span className="hushh-gradient-text">Your options</span>
        </h1>
        <p className="text-[17px] font-medium text-muted-foreground leading-snug">
          Let Kai analyze your holdings for precise advice
        </p>
      </div>

      <div className="text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Choose import method
        </p>
      </div>

      {/* Plaid integration */}
      <SurfaceCard accent="sky">
        <SurfaceCardContent className="space-y-3 p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/15 flex items-center justify-center shrink-0">
                <Icon icon={Link2} size="md" className="text-primary" />
              </div>
              <div className="min-w-0">
                <h3 className="text-[17px] font-semibold leading-tight">Connect with Plaid</h3>
                <p className="text-[13px] font-medium text-muted-foreground leading-snug">
                  Automatically sync your brokerage accounts
                </p>
              </div>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-2">
              <Badge className="border border-[var(--brand-200)] bg-[var(--brand-50)] text-[var(--brand-700)]">
                Read-only sync
              </Badge>
              {plaidConnectedInstitutionCount > 0 ? (
                <Badge variant="outline">
                  {plaidConnectedInstitutionCount} connection{plaidConnectedInstitutionCount === 1 ? "" : "s"}
                </Badge>
              ) : plaidConfigured === false ? (
                <Badge variant="outline">Not configured</Badge>
              ) : (
                <Badge variant="outline">Broker-sourced</Badge>
              )}
            </div>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Best for brokerage-sourced holdings, refreshable sync status, and non-editable portfolio context.
          </p>
          <MorphyButton
            variant="blue-gradient"
            effect="fill"
            size="lg"
            className="w-full border-none font-black shadow-xl"
            disabled={!onConnectPlaid || isUploading || isPreloadingSchema || isConnectingPlaid || plaidConfigured === false}
            onClick={handleConnectPlaid}
            icon={{
              icon: isConnectingPlaid ? Loader2 : Link2,
              gradient: false,
            }}
          >
            {plaidConfigured === false
              ? "Plaid unavailable"
              : isConnectingPlaid
                ? "Opening Plaid..."
                : plaidConnectedInstitutionCount > 0
                  ? "Connect Another Brokerage"
                  : "Connect Brokerage With Plaid"}
          </MorphyButton>
          <p className="text-[11px] text-muted-foreground">
            Plaid data stays read-only in Kai. Statements remain your editable source.
          </p>
        </SurfaceCardContent>
      </SurfaceCard>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          or
        </span>
        <div className="h-px flex-1 bg-border/60" />
      </div>

      {/* Statement upload */}
      <SurfaceCard>
        <SurfaceCardContent className="space-y-4 p-4 md:p-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-primary/10 border border-primary/15 flex items-center justify-center shrink-0">
              <Icon icon={Upload} size="md" className="text-primary" />
            </div>
            <div>
              <h3 className="text-[17px] font-semibold text-foreground">Upload statement</h3>
              <p className="text-[13px] font-medium text-muted-foreground">
                Import official brokerage PDF or CSV manually
              </p>
            </div>
          </div>

          {/* Drag & Drop Zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={cn(
              "relative border border-dashed rounded-3xl p-7 transition-all duration-200 text-center cursor-pointer min-h-44 flex flex-col items-center justify-center",
              isDragging
                ? "border-primary bg-primary/8 scale-[1.01]"
                : "border-border/70 hover:border-primary/50 hover:bg-muted/25",
              isUploading && "pointer-events-none opacity-50"
            )}
            onClick={triggerFileInput}
          >
            {/* Upload Icon */}
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 border border-primary/15 flex items-center justify-center mb-3">
              <Icon icon={Upload} size={30} className="text-primary" />
            </div>

            {/* Text */}
            <div className="space-y-1">
              <h3 className="text-[17px] font-semibold text-primary">
                {isDragging
                  ? "Drop your file here"
                  : "Tap to upload official statement"}
              </h3>
              <p className="text-[14px] font-medium text-muted-foreground">
                PDF or CSV
              </p>
            </div>

            {/* Selected File Display */}
            {selectedFile && !isUploading && (
              <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary/10 rounded-full text-sm">
                <Icon icon={FileText} size="sm" />
                <span>{selectedFile.name}</span>
                <Icon icon={CheckCircle} size="sm" className="text-green-500" />
              </div>
            )}

            {/* Hidden File Input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.pdf"
              onChange={handleFileChange}
              className="hidden"
              disabled={isUploading}
            />
          </div>

          <MorphyButton
            variant="morphy"
            effect="fill"
            size="default"
            className="w-full font-black shadow-xl border-none"
            onClick={handleContinue}
            disabled={isUploading || isPreloadingSchema || !selectedFile}
            icon={{
              icon: Upload,
              gradient: false,
            }}
          >
            {isUploading ? "Parsing..." : "Continue"}
          </MorphyButton>
        </SurfaceCardContent>
      </SurfaceCard>

      {selectionError && (
        <p className="text-xs text-destructive px-2">{selectionError}</p>
      )}

      <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
        <Icon icon={AlertCircle} size="sm" className="mt-0.5 text-muted-foreground shrink-0" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          We support official brokerage statements from all major systems.
        </p>
      </div>

      {onPreloadSchema ? (
        <div className="space-y-1.5">
          <MorphyButton
            variant="blue-gradient"
            effect="fill"
            size="lg"
            className="w-full border-none font-black shadow-xl"
            onClick={handlePreloadSchema}
            disabled={isUploading || isPreloadingSchema}
            icon={{
              icon: isPreloadingSchema ? Loader2 : Database,
              gradient: false,
            }}
          >
            {isPreloadingSchema ? "Loading Sample Brokerage..." : "Load Sample Brokerage"}
          </MorphyButton>
          <p className="px-1 text-[11px] text-muted-foreground">
            Load demo portfolio data any time, review it, then save to vault.
          </p>
        </div>
      ) : null}

      {/* Skip Option */}
      <div className="text-center pt-1">
        <MorphyButton
          variant="none"
          effect="fade"
          onClick={onSkip}
          disabled={isUploading || isPreloadingSchema}
          className="text-muted-foreground hover:text-foreground text-base"
        >
          Skip for now
        </MorphyButton>
      </div>
    </div>
  );
}
