"use client";

import { useDeferredValue, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Database,
  Eye,
  Folder,
  RefreshCw,
  X,
} from "lucide-react";

import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { PkmSectionPreview } from "@/components/profile/pkm-section-preview";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/lib/morphy-ux/morphy";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  buildPkmAccessConnections,
  type PkmDomainPermissionPresentation,
  type PkmAccessConnectionPresentation,
  type PkmDomainPresentation,
  type PkmProfileSummaryPresentation,
  type PkmDomainUpgradePresentation,
} from "@/lib/profile/pkm-profile-presentation";
import type { PkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";
import type { PkmUpgradeDomainState } from "@/lib/services/personal-knowledge-model-service";
import { cn } from "@/lib/utils";

const listShellClassName = cn(
  "overflow-hidden rounded-[var(--app-card-radius-feature)]",
  "border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]"
);

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initials(label: string | null | undefined): string {
  return String(label || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "HK";
}

function formatDomainRowTimestamp(value: string | null | undefined): string | null {
  const formatted = formatTimestamp(value);
  return formatted === "Unavailable" ? null : `Updated ${formatted}`;
}

function getDomainRowStatus(domain: PkmDomainPresentation): {
  label: string;
  className: string;
} | null {
  if (domain.status === "stale") {
    return {
      label: "Refresh recommended",
      className: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  return null;
}

function DomainCard({
  domain,
  onOpen,
}: {
  domain: PkmDomainPresentation;
  onOpen: () => void;
}) {
  const itemLabel =
    domain.detailCount > 0
      ? `${domain.detailCount} item${domain.detailCount === 1 ? "" : "s"}`
      : "0 items";
  const sourceSummary =
    domain.sourceLabels.length > 2
      ? `${domain.sourceLabels.slice(0, 2).join(" · ")} +${domain.sourceLabels.length - 2}`
      : domain.sourceLabels.join(" · ") || "Saved memory";
  const updatedLabel = formatDomainRowTimestamp(domain.updatedAt);
  const status = getDomainRowStatus(domain);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group w-full rounded-none bg-transparent text-left shadow-none transition-colors duration-150",
        "hover:bg-[color:var(--app-card-surface-compact)]/72",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-inset"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="text-sm font-semibold tracking-tight text-foreground">{domain.title}</p>
            {status ? (
              <Badge variant="outline" className={status.className}>
                {status.label}
              </Badge>
            ) : null}
            {updatedLabel ? (
              <span className="text-xs text-muted-foreground">{updatedLabel}</span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{itemLabel}</Badge>
            <Badge variant="secondary">{sourceSummary}</Badge>
            <span className="min-w-0 truncate">{domain.accessSummary}</span>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

export function PkmDataManagerPanel({
  signedIn,
  loading,
  metadataReady,
  metadataError,
  sharingReady,
  sharingError: _sharingError,
  needsVaultCreation,
  needsUnlock,
  summary,
  domains,
  manifestsByDomain,
  loadingManifestsByDomain,
  manifestErrorsByDomain,
  upgradeStatesByDomain,
  onOpenSharing,
  onOpenImport,
  onRefresh,
  onOpenDomain,
}: {
  signedIn: boolean;
  loading: boolean;
  metadataReady: boolean;
  metadataError?: string | null;
  sharingReady: boolean;
  sharingError?: string | null;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
  summary: PkmProfileSummaryPresentation | null;
  domains: PkmDomainPresentation[];
  manifestsByDomain: Record<string, DomainManifest | null | undefined>;
  loadingManifestsByDomain: Record<string, boolean>;
  manifestErrorsByDomain: Record<string, string | null>;
  upgradeStatesByDomain: Record<string, PkmUpgradeDomainState>;
  onOpenSharing: () => void;
  onOpenImport: () => void;
  onRefresh: () => void;
  onOpenDomain: (domain: PkmDomainPresentation) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const readyDomainCount = domains.filter((domain) => manifestsByDomain[domain.key] !== undefined).length;
  const loadingDomainCount = Object.values(loadingManifestsByDomain).filter(Boolean).length;
  const domainErrorCount = Object.values(manifestErrorsByDomain).filter(Boolean).length;
  const upgradingDomainCount = Object.keys(upgradeStatesByDomain).length;
  const shouldShowSearch = domains.length >= 6;
  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const filteredDomains = useMemo(() => {
    if (!normalizedSearchQuery) return domains;
    return domains.filter((domain) => {
      const haystack = [
        domain.title,
        domain.summary,
        domain.sourceLabels.join(" "),
        domain.sections.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearchQuery);
    });
  }, [domains, normalizedSearchQuery]);

  if (!signedIn) {
    return (
      <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
        Sign in to review and manage your saved data.
      </SurfaceInset>
    );
  }

  if (needsVaultCreation) {
    return (
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            Set up Personal Knowledge Model
          </SurfaceCardTitle>
          <SurfaceCardDescription>
            Create your vault first so Kai can save your domains and sharing controls here.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent>
          <Button onClick={onOpenImport}>Create vault</Button>
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  if (loading && !summary) {
    return (
      <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading your Personal Knowledge Model...
      </SurfaceInset>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {summary ? (
            <>
              {metadataReady ? (
                <>
                  <Badge variant="secondary">{summary.totalDomains} domains</Badge>
                  <Badge variant="secondary">{summary.totalAttributes} items</Badge>
                </>
              ) : loading ? (
                <Badge variant="outline">Checking data</Badge>
              ) : metadataError ? (
                <Badge variant="outline">Data unavailable</Badge>
              ) : null}
              {sharingReady ? (
                <Badge variant="secondary">{summary.activeGrantCount} active access</Badge>
              ) : null}
              {upgradingDomainCount > 0 ? (
                <Badge variant="outline">{upgradingDomainCount} updating</Badge>
              ) : readyDomainCount > 0 && domainErrorCount === 0 && loadingDomainCount === 0 ? (
                <Badge variant="outline">Ready to manage</Badge>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!needsUnlock ? <Button onClick={onOpenSharing}>Manage sharing</Button> : null}
          <Button variant="none" effect="fade" onClick={onRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {shouldShowSearch ? (
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search domains"
          aria-label="Search domains"
          className="h-10"
        />
      ) : null}

      {!metadataReady ? (
        <SurfaceInset className="p-4 text-sm text-muted-foreground">
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {metadataError ? "Personal Knowledge Model unavailable" : "Checking your saved domains"}
            </p>
            <p>
              {metadataError
                ? metadataError
                : "Domain summaries, source health, and sharing controls are still loading."}
            </p>
          </div>
        </SurfaceInset>
      ) : filteredDomains.length === 0 ? (
        <SurfaceInset className="p-4 text-sm text-muted-foreground">
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {domains.length === 0 ? "No saved domains yet" : "No matching domains"}
            </p>
            <p>
              {domains.length === 0
                ? "Once Kai saves your first memory or import, it will appear here as a domain you can review and share."
                : "Try a different search term to find a saved domain."}
            </p>
          </div>
        </SurfaceInset>
      ) : (
        <div className={listShellClassName}>
          <div className="divide-y divide-[color:var(--app-card-border-standard)]">
            {filteredDomains.map((domain) => (
              <DomainCard
                key={domain.key}
                domain={domain}
                onOpen={() => onOpenDomain(domain)}
              />
            ))}
          </div>
        </div>
      )}

      {loadingDomainCount > 0 || domainErrorCount > 0 ? (
        <SurfaceInset className="flex flex-wrap items-center gap-2 p-4 text-sm text-muted-foreground">
          {loadingDomainCount > 0 ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Preparing sharing controls for {loadingDomainCount} domain{loadingDomainCount === 1 ? "" : "s"}.</span>
            </>
          ) : null}
          {domainErrorCount > 0 ? (
            <span>
              Refresh needed for {domainErrorCount} domain{domainErrorCount === 1 ? "" : "s"}.
            </span>
          ) : null}
        </SurfaceInset>
      ) : null}
    </div>
  );
}

function ConnectionCard({
  connection,
  onOpen,
}: {
  connection: PkmAccessConnectionPresentation;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group w-full rounded-none bg-transparent text-left shadow-none transition-colors duration-150",
        "hover:bg-[color:var(--app-card-surface-compact)]/72",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-inset"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <Avatar className="h-10 w-10 shrink-0 border">
          <AvatarImage src={connection.requesterImageUrl || undefined} alt={connection.requesterLabel} />
          <AvatarFallback>{initials(connection.requesterLabel)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="text-sm font-semibold tracking-tight text-foreground">{connection.requesterLabel}</p>
            {connection.broadAccessCount > 0 ? (
              <Badge
                variant="outline"
                className="border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              >
                {connection.broadAccessCount} broad
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">
              {connection.accessCount} access point{connection.accessCount === 1 ? "" : "s"}
            </Badge>
            <Badge variant="secondary">
              {connection.domains.length} domain{connection.domains.length === 1 ? "" : "s"}
            </Badge>
            <span className="min-w-0 truncate">{connection.domains.slice(0, 2).join(" · ")}</span>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

export function PkmDomainDetailPanel({
  domain,
  permissions,
  upgrade,
  manifestLoading,
  manifestError,
  pendingPermissionKeys,
  previewOpen,
  previewTitle,
  previewDescription,
  previewPresentation,
  previewLoading,
  previewError,
  onPreviewOpenChange,
  onPreviewPermission,
  onTogglePermission,
}: {
  domain: PkmDomainPresentation;
  permissions: PkmDomainPermissionPresentation[];
  upgrade: PkmDomainUpgradePresentation;
  manifestLoading?: boolean;
  manifestError?: string | null;
  pendingPermissionKeys?: string[];
  previewOpen: boolean;
  previewTitle: string;
  previewDescription?: string | null;
  previewPresentation: PkmSectionPreviewPresentation | null;
  previewLoading: boolean;
  previewError?: string | null;
  onPreviewOpenChange: (open: boolean) => void;
  onPreviewPermission: (permission: PkmDomainPermissionPresentation) => void;
  onTogglePermission: (permission: PkmDomainPermissionPresentation, nextValue: boolean) => void;
}) {
  const updatedLabel = formatDomainRowTimestamp(domain.updatedAt);
  return (
    <div className="space-y-4">
      <SurfaceInset className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold tracking-tight text-foreground">{domain.summary}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {updatedLabel ? <span>{updatedLabel}</span> : null}
              <span>{domain.accessSummary}</span>
            </div>
          </div>
          {getDomainRowStatus(domain) ? (
            <Badge variant="outline" className={getDomainRowStatus(domain)?.className}>
              {getDomainRowStatus(domain)?.label}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">
            {domain.detailCount} item{domain.detailCount === 1 ? "" : "s"}
          </Badge>
          {domain.sourceLabels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
          {domain.sections.length ? (
            <Badge variant="secondary">
              {domain.sections.length} section{domain.sections.length === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
      </SurfaceInset>

      {domain.highlights.length > 0 ? (
        <SurfaceInset className="space-y-2 p-4">
          {domain.highlights.slice(0, 5).map((highlight) => (
            <p key={highlight} className="text-sm leading-6 text-foreground/90">
              {highlight}
            </p>
          ))}
        </SurfaceInset>
      ) : null}

      <SurfaceCard>
        <SurfaceCardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <SurfaceCardTitle>Sharing controls</SurfaceCardTitle>
              <SurfaceCardDescription>
                Choose which sections of this domain are available when you approve access.
              </SurfaceCardDescription>
            </div>
            <Badge
              variant="outline"
              className={cn(
                upgrade.status === "current"
                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              )}
            >
              {upgrade.label}
            </Badge>
          </div>
        </SurfaceCardHeader>
        <SurfaceCardContent className="space-y-3">
          <SurfaceInset className="p-4 text-sm text-muted-foreground">{upgrade.description}</SurfaceInset>
          {manifestError ? (
            <SurfaceInset className="flex items-start gap-2 p-4 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{manifestError}</span>
            </SurfaceInset>
          ) : null}
          {manifestLoading ? (
            <SurfaceInset className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Loading shareable sections...
            </SurfaceInset>
          ) : permissions.length > 0 ? (
            permissions.map((permission) => {
              const pending = pendingPermissionKeys?.includes(permission.key) ?? false;
              const disabled = pending || Boolean(permission.disabledReason);
              return (
                <div
                  key={permission.key}
                  className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">{permission.label}</p>
                        <Badge variant="outline">{permission.sensitivityTier}</Badge>
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{permission.description}</p>
                      <p className="text-xs text-muted-foreground">{permission.counterpartSummary}</p>
                      {permission.requesterLabels.length > 0 ? (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {permission.requesterLabels.map((label) => (
                            <Badge key={label} variant="secondary">
                              {label}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                      {permission.disabledReason ? (
                        <p className="text-xs text-muted-foreground">{permission.disabledReason}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      <Button
                        variant="none"
                        effect="fade"
                        size="sm"
                        onClick={() => onPreviewPermission(permission)}
                        aria-label={`View ${permission.label} data`}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {pending ? (
                        <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : null}
                      <Switch
                        checked={permission.exposureEnabled}
                        onCheckedChange={(nextValue) => onTogglePermission(permission, nextValue)}
                        disabled={disabled}
                        aria-label={`Toggle ${permission.label} sharing`}
                      />
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <SurfaceInset className="p-4 text-sm text-muted-foreground">
              Section-level sharing controls will appear here once this domain manifest is ready.
            </SurfaceInset>
          )}
        </SurfaceCardContent>
      </SurfaceCard>

      <Dialog open={previewOpen} onOpenChange={onPreviewOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100%-2.5rem)] max-h-[calc(100svh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[min(26rem,calc(100vw-8rem))] lg:max-w-[min(27rem,calc(100vw-12rem))]"
        >
          <div className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_2.5rem] items-start gap-4 border-b border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-8 pb-4 pt-5 sm:px-9">
            <DialogHeader className="min-w-0 flex-1 text-left">
              <DialogTitle>{previewTitle}</DialogTitle>
              <DialogDescription>
                {previewDescription || "Exact saved values for this section."}
              </DialogDescription>
            </DialogHeader>
            <DialogClose asChild>
              <button
                type="button"
                className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-transparent bg-[color:var(--app-card-surface-compact)] text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </DialogClose>
          </div>
          <div className="min-h-0 overflow-y-auto px-8 pb-7 pt-4 sm:px-9">
            {previewLoading ? (
              <SurfaceInset className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading saved values...
              </SurfaceInset>
            ) : previewError ? (
              <SurfaceInset className="flex items-start gap-2 p-4 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{previewError}</span>
              </SurfaceInset>
            ) : previewPresentation ? (
              <PkmSectionPreview presentation={previewPresentation} />
            ) : (
              <SurfaceInset className="p-4 text-sm text-muted-foreground">
                No saved values are available for this section yet.
              </SurfaceInset>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function PkmAccessManagerPanel({
  signedIn,
  loading,
  sharingReady,
  sharingError,
  summary,
  domains,
  onOpenConnection,
  onRevokeAccess: _onRevokeAccess,
}: {
  signedIn: boolean;
  loading: boolean;
  sharingReady: boolean;
  sharingError?: string | null;
  summary: PkmProfileSummaryPresentation | null;
  domains: PkmDomainPresentation[];
  onOpenConnection: (connection: PkmAccessConnectionPresentation) => void;
  onRevokeAccess: (scope: string) => Promise<void>;
}) {
  const connections = useMemo(() => buildPkmAccessConnections(domains), [domains]);

  if (!signedIn) {
    return (
      <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
        Sign in to review access and consent relationships.
      </SurfaceInset>
    );
  }

  if (loading && !summary) {
    return (
      <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading access state...
      </SurfaceInset>
    );
  }

  return (
    <div className="space-y-4">
      {summary && sharingReady ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{summary.activeGrantCount} active grants</Badge>
          <Badge variant="secondary">{summary.sharedDomainCount} shared domains</Badge>
          {connections.length > 0 ? (
            <Badge variant="secondary">{connections.length} connections</Badge>
          ) : null}
        </div>
      ) : null}

      {!sharingReady ? (
        <SurfaceInset className="p-4 text-sm text-muted-foreground">
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {sharingError ? "Access state unavailable" : "Checking active access"}
            </p>
            <p>
              {sharingError
                ? sharingError
                : "Live grants and sharing relationships are still loading."}
            </p>
          </div>
        </SurfaceInset>
      ) : connections.length === 0 ? (
        <SurfaceInset className="p-4 text-sm text-muted-foreground">
          <div className="space-y-1">
            <p className="font-medium text-foreground">No active access right now</p>
            <p>Your personal data is not currently shared with connected apps or advisors.</p>
          </div>
        </SurfaceInset>
      ) : (
        <div className="space-y-3">
          <div className={listShellClassName}>
            <div className="divide-y divide-[color:var(--app-card-border-standard)]">
              {connections.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onOpen={() => onOpenConnection(connection)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function PkmAccessConnectionDetailPanel({
  connection,
  onRevokeAccess,
}: {
  connection: PkmAccessConnectionPresentation;
  onRevokeAccess: (scope: string) => Promise<void>;
}) {
  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Avatar className="h-11 w-11 border">
              <AvatarImage src={connection.requesterImageUrl || undefined} alt={connection.requesterLabel} />
              <AvatarFallback>{initials(connection.requesterLabel)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 space-y-1">
              <SurfaceCardTitle>{connection.requesterLabel}</SurfaceCardTitle>
              <SurfaceCardDescription>
                {connection.accessCount} active access point{connection.accessCount === 1 ? "" : "s"} across{" "}
                {connection.domains.length} domain{connection.domains.length === 1 ? "" : "s"}
              </SurfaceCardDescription>
            </div>
          </div>
          {connection.broadAccessCount > 0 ? (
            <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300">
              {connection.broadAccessCount} broad
            </Badge>
          ) : null}
        </div>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {connection.domains.map((domain) => (
            <Badge key={domain} variant="secondary">
              {domain}
            </Badge>
          ))}
        </div>
        {connection.grants.map((grant) => (
          <div
            key={grant.id}
            className="flex items-start justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-3.5"
          >
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-foreground">{grant.domainTitle}</p>
              <p className="text-xs leading-5 text-muted-foreground">{grant.readableAccessLabel}</p>
              <p className="text-[11px] text-muted-foreground">Expires {formatTimestamp(grant.expiresAt)}</p>
            </div>
            <Button variant="none" effect="fade" size="sm" onClick={() => void onRevokeAccess(grant.scope)}>
              Revoke
            </Button>
          </div>
        ))}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

export function ProfileStateNotice({
  title,
  description,
  tone = "default",
}: {
  title: string;
  description: string;
  tone?: "default" | "warning" | "critical";
}) {
  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <SurfaceCardTitle className="flex items-center gap-2">
          {tone === "critical" ? (
            <AlertTriangle className="h-4 w-4 text-rose-500" />
          ) : tone === "warning" ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          ) : (
            <Folder className="h-4 w-4" />
          )}
          {title}
        </SurfaceCardTitle>
        <SurfaceCardDescription>{description}</SurfaceCardDescription>
      </SurfaceCardHeader>
    </SurfaceCard>
  );
}
