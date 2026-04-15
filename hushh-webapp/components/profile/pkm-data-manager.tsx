"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  Database,
  ExternalLink,
  Folder,
  Lock,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceInset,
  surfaceInteractiveShellClassName,
} from "@/components/app-ui/surfaces";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/morphy";
import {
  buildPkmAccessConnections,
  type PkmAccessConnectionPresentation,
  type PkmDensity,
  type PkmDomainPresentation,
  type PkmProfileSummaryPresentation,
} from "@/lib/profile/pkm-profile-presentation";
import { cn } from "@/lib/utils";

export type ProfileSourceHealthEntry = {
  id: string;
  label: string;
  detail: string;
  status: string;
  tone?: "default" | "warning" | "critical" | "success";
};

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

function statusBadgeClassName(status: PkmDomainPresentation["status"]) {
  if (status === "complete") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "stale") {
    return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (status === "missing") {
    return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  return "border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] text-muted-foreground";
}

function toneBadgeClassName(tone: ProfileSourceHealthEntry["tone"]) {
  if (tone === "success") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "warning") {
    return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (tone === "critical") {
    return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  return "border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] text-muted-foreground";
}

function densityClasses(density: PkmDensity) {
  if (density === "dense") {
    return {
      domainGrid: "grid-cols-1 lg:grid-cols-2",
      cardPadding: "p-4",
    };
  }
  if (density === "compact") {
    return {
      domainGrid: "grid-cols-1 xl:grid-cols-2",
      cardPadding: "p-4 sm:p-5",
    };
  }
  return {
    domainGrid: "grid-cols-1 xl:grid-cols-2",
    cardPadding: "p-5",
  };
}

function AttentionRail({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <SurfaceCardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          Needs attention
        </SurfaceCardTitle>
        <SurfaceCardDescription>What to review next.</SurfaceCardDescription>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-2">
        {items.map((item) => (
          <div
            key={item}
            className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-3.5 py-3 text-sm text-foreground/88"
          >
            {item}
          </div>
        ))}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function SourceHealthList({ entries }: { entries: ProfileSourceHealthEntry[] }) {
  if (!entries.length) return null;
  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <SurfaceCardTitle>Source health</SurfaceCardTitle>
        <SurfaceCardDescription>Connections and sources feeding your data manager.</SurfaceCardDescription>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-3">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-start justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-3.5 py-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold tracking-tight text-foreground">{entry.label}</p>
              <p className="text-xs leading-5 text-muted-foreground">{entry.detail}</p>
            </div>
            <Badge variant="outline" className={toneBadgeClassName(entry.tone)}>
              {entry.status}
            </Badge>
          </div>
        ))}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function DomainCard({
  domain,
  density,
  onOpen,
}: {
  domain: PkmDomainPresentation;
  density: PkmDensity;
  onOpen: () => void;
}) {
  const compact = density !== "relaxed";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        surfaceInteractiveShellClassName,
        "group w-full overflow-hidden rounded-[var(--app-card-radius-feature)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2"
      )}
    >
      <div className={cn("space-y-4", compact ? "p-4" : "p-5")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {domain.title}
            </p>
            <p className="line-clamp-3 text-sm leading-6 text-foreground/90">{domain.summary}</p>
          </div>
          <Badge variant="outline" className={statusBadgeClassName(domain.status)}>
            {domain.statusLabel}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{domain.detailCount} items</Badge>
          {domain.sourceLabels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
          {domain.attentionFlags.map((flag) => (
            <Badge key={flag} variant="outline">
              {flag}
            </Badge>
          ))}
        </div>

        {domain.highlights.length > 0 ? (
          <div className="space-y-2">
            {domain.highlights.slice(0, compact ? 2 : 3).map((highlight) => (
              <p key={highlight} className="text-xs leading-5 text-muted-foreground">
                {highlight}
              </p>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-between border-t border-[color:var(--app-card-border-standard)] pt-3">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Access
            </p>
            <p className="text-sm font-medium text-foreground">{domain.accessSummary}</p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Updated
            </p>
            <p className="text-xs text-foreground/80">{formatTimestamp(domain.updatedAt)}</p>
          </div>
        </div>
      </div>
    </button>
  );
}

export function PkmDataManagerPanel({
  signedIn,
  loading,
  needsVaultCreation,
  needsUnlock,
  summary,
  domains,
  sourceHealth,
  canShowAdvancedTools,
  onOpenAdvancedTools,
  onOpenConsentCenter,
  onOpenImport,
  onRequestVaultUnlock,
  onRefresh,
  onOpenDomain,
  onRevokeAccess: _onRevokeAccess,
}: {
  signedIn: boolean;
  loading: boolean;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
  summary: PkmProfileSummaryPresentation | null;
  domains: PkmDomainPresentation[];
  sourceHealth: ProfileSourceHealthEntry[];
  canShowAdvancedTools?: boolean;
  onOpenAdvancedTools?: () => void;
  onOpenConsentCenter: () => void;
  onOpenImport: () => void;
  onRequestVaultUnlock: () => void;
  onRefresh: () => void;
  onOpenDomain: (domain: PkmDomainPresentation) => void;
  onRevokeAccess: (scope: string) => Promise<void>;
}) {
  const density = summary?.density || "compact";
  const classes = densityClasses(density);

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
            Start your data manager
          </SurfaceCardTitle>
          <SurfaceCardDescription>
            Create your vault first so Kai can save readable data for you to manage here.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent>
          <Button onClick={onOpenImport}>Create vault from import</Button>
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  if (needsUnlock) {
    return (
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Unlock to manage your data
          </SurfaceCardTitle>
          <SurfaceCardDescription>
            Your personal data manager appears after vault unlock. Access summaries stay permission-safe.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent className="flex flex-wrap gap-3">
          <Button onClick={onRequestVaultUnlock}>Unlock vault</Button>
          <Button variant="none" effect="fade" onClick={onOpenConsentCenter}>
            Open consent center
          </Button>
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  if (loading && !summary) {
    return (
      <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Building your readable data manager...
      </SurfaceInset>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            My Data
          </p>
          <h2 className="text-base font-semibold tracking-tight text-foreground">What Kai knows about you</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Readable domain summaries, source health, and access state in one compact manager.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary ? (
            <>
              <Badge variant="secondary">{summary.totalDomains} domains</Badge>
              <Badge variant="secondary">{summary.totalAttributes} items</Badge>
              <Badge variant="secondary">{summary.activeGrantCount} active access</Badge>
            </>
          ) : null}
          <Button variant="none" effect="fade" onClick={onRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          {canShowAdvancedTools && onOpenAdvancedTools ? (
            <Button variant="none" effect="fade" onClick={onOpenAdvancedTools}>
              Advanced tools
            </Button>
          ) : null}
        </div>
      </div>

      <AttentionRail items={summary?.attentionItems || []} />

      {summary?.recentDomainTitles?.length ? (
        <SurfaceCard>
          <SurfaceCardHeader>
            <SurfaceCardTitle>Recent changes</SurfaceCardTitle>
            <SurfaceCardDescription>Most recently updated parts of your data.</SurfaceCardDescription>
          </SurfaceCardHeader>
          <SurfaceCardContent className="flex flex-wrap gap-2">
            {summary.recentDomainTitles.map((title) => (
              <Badge key={title} variant="secondary">
                {title}
              </Badge>
            ))}
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}

      <SourceHealthList entries={sourceHealth} />

      {domains.length === 0 ? (
        <SurfaceCard>
          <SurfaceCardHeader>
            <SurfaceCardTitle>No saved domains yet</SurfaceCardTitle>
            <SurfaceCardDescription>
              Once Kai writes your first memory or import, it will show up here in a readable shape.
            </SurfaceCardDescription>
          </SurfaceCardHeader>
        </SurfaceCard>
      ) : (
        <div className={cn("grid gap-3", classes.domainGrid)}>
          {domains.map((domain) => (
            <DomainCard
              key={domain.key}
              domain={domain}
              density={density}
              onOpen={() => onOpenDomain(domain)}
            />
          ))}
        </div>
      )}
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
        surfaceInteractiveShellClassName,
        "group w-full overflow-hidden rounded-[var(--app-card-radius-feature)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2"
      )}
    >
      <SurfaceCard className="border-none bg-transparent shadow-none">
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
            <div className="flex flex-col items-end gap-2">
              {connection.broadAccessCount > 0 ? (
                <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                  {connection.broadAccessCount} broad
                </Badge>
              ) : null}
              <Badge variant="secondary">View detail</Badge>
            </div>
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
          <div className="space-y-2">
            {connection.grants.slice(0, 2).map((grant) => (
              <div
                key={grant.id}
                className="flex items-start justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-3.5"
              >
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-foreground">{grant.domainTitle}</p>
                  <p className="text-xs leading-5 text-muted-foreground">{grant.readableAccessLabel}</p>
                </div>
              </div>
            ))}
          </div>
        </SurfaceCardContent>
      </SurfaceCard>
    </button>
  );
}

export function PkmDomainDetailPanel({
  domain,
  onOpenConsentCenter,
  onRevokeAccess,
}: {
  domain: PkmDomainPresentation;
  onOpenConsentCenter: () => void;
  onRevokeAccess: (scope: string) => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <SurfaceInset className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold tracking-tight text-foreground">
              {domain.accessSummary}
            </p>
            <p className="text-xs text-muted-foreground">
              Updated {formatTimestamp(domain.updatedAt)}
            </p>
          </div>
          <Badge variant="outline" className={statusBadgeClassName(domain.status)}>
            {domain.statusLabel}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {domain.sourceLabels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
        </div>
      </SurfaceInset>

      {domain.highlights.length ? (
        <SurfaceInset className="space-y-2 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Highlights
          </p>
          <div className="space-y-2">
            {domain.highlights.map((highlight) => (
              <p key={highlight} className="text-sm leading-6 text-foreground/90">
                {highlight}
              </p>
            ))}
          </div>
        </SurfaceInset>
      ) : null}

      {domain.sections.length ? (
        <SurfaceInset className="space-y-2 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Sections
          </p>
          <div className="flex flex-wrap gap-2">
            {domain.sections.map((section) => (
              <Badge key={section} variant="outline">
                {section}
              </Badge>
            ))}
          </div>
        </SurfaceInset>
      ) : null}

      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle>Access</SurfaceCardTitle>
          <SurfaceCardDescription>
            Review who can currently read this domain and revoke access inline.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent className="space-y-3">
          {domain.accessEntries.length ? (
            domain.accessEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-4"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Avatar className="h-10 w-10 border">
                    <AvatarImage src={entry.requesterImageUrl || undefined} alt={entry.requesterLabel} />
                    <AvatarFallback>{initials(entry.requesterLabel)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{entry.requesterLabel}</p>
                      <Badge variant="secondary">
                        {entry.coverageKind === "broad" ? "Broad access" : "Limited access"}
                      </Badge>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">{entry.readableAccessLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      Expires {formatTimestamp(entry.expiresAt)}
                    </p>
                  </div>
                </div>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => void onRevokeAccess(entry.scope)}
                >
                  Revoke
                </Button>
              </div>
            ))
          ) : (
            <SurfaceInset className="p-4 text-sm text-muted-foreground">
              No connected apps or advisors have active access to this domain.
            </SurfaceInset>
          )}
          <Button variant="none" effect="fade" onClick={onOpenConsentCenter}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open consent center
          </Button>
        </SurfaceCardContent>
      </SurfaceCard>
    </div>
  );
}

export function PkmAccessManagerPanel({
  signedIn,
  loading,
  summary,
  domains,
  onOpenConnection,
  onOpenConsentCenter,
  onRevokeAccess: _onRevokeAccess,
}: {
  signedIn: boolean;
  loading: boolean;
  summary: PkmProfileSummaryPresentation | null;
  domains: PkmDomainPresentation[];
  onOpenConnection: (connection: PkmAccessConnectionPresentation) => void;
  onOpenConsentCenter: () => void;
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
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Access overview
          </SurfaceCardTitle>
          <SurfaceCardDescription>
            Manage live grants here, then use the full consent center when you need the full history.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent className="space-y-3">
          {summary ? (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{summary.activeGrantCount} active grants</Badge>
              <Badge variant="secondary">{summary.sharedDomainCount} shared domains</Badge>
              {summary.staleDomainCount > 0 ? (
                <Badge variant="outline">{summary.staleDomainCount} stale</Badge>
              ) : null}
              {summary.missingDomainCount > 0 ? (
                <Badge variant="outline">{summary.missingDomainCount} missing</Badge>
              ) : null}
            </div>
          ) : null}
          <Button variant="none" effect="fade" onClick={onOpenConsentCenter}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open consent center
          </Button>
        </SurfaceCardContent>
      </SurfaceCard>

      {connections.length === 0 ? (
        <SurfaceCard>
          <SurfaceCardHeader>
            <SurfaceCardTitle>No active access right now</SurfaceCardTitle>
            <SurfaceCardDescription>
              Your personal data is not currently shared with connected apps or advisors.
            </SurfaceCardDescription>
          </SurfaceCardHeader>
        </SurfaceCard>
      ) : (
        <div className="space-y-3">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              onOpen={() => onOpenConnection(connection)}
            />
          ))}
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
