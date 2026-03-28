"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { ReadonlyURLSearchParams } from "next/navigation";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, Loader2, Search, ShieldCheck } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { SettingsGroup, SettingsRow, SettingsSegmentedTabs } from "@/components/profile/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { usePendingConsentCount, useConsentNotificationState } from "@/components/consent/notification-provider";
import { useAuth } from "@/hooks/use-auth";
import { useConsentActions, type PendingConsent } from "@/lib/consent";
import { usePersonaState } from "@/lib/persona/persona-context";
import {
  ConsentCenterService,
  type ConsentCenterActor,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { Button } from "@/lib/morphy-ux/button";
import { buildRiaWorkspaceRoute } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

type ConsentTab = "pending" | "active" | "previous";

const PENDING_STATUSES = new Set(["pending", "request_pending", "sent"]);
const ACTIVE_STATUSES = new Set(["active"]);

function normalizeTab(value: string | null): ConsentTab {
  if (value === "active" || value === "previous") return value;
  return "pending";
}

function normalizeActor(
  value: string | null,
  fallback: ConsentCenterActor
): ConsentCenterActor {
  return value === "ria" || value === "investor" ? value : fallback;
}

function resolveConsentTab(searchParams: URLSearchParams | ReadonlyURLSearchParams): ConsentTab {
  const tabParam = searchParams.get("tab");
  if (tabParam) {
    return normalizeTab(tabParam);
  }

  const viewParam = searchParams.get("view");
  if (viewParam === "pending" || viewParam === "active" || viewParam === "previous") {
    return normalizeTab(viewParam);
  }

  return "pending";
}

function formatStatus(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function filterEntriesForTab(entries: ConsentCenterEntry[], tab: ConsentTab) {
  return entries.filter((entry) => {
    const status = String(entry.status || "").trim().toLowerCase();
    if (tab === "pending") return PENDING_STATUSES.has(status);
    if (tab === "active") return ACTIVE_STATUSES.has(status);
    return !PENDING_STATUSES.has(status) && !ACTIVE_STATUSES.has(status);
  });
}

function formatDate(value?: string | number | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function formatRelative(value?: string | number | null) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const deltaMs = timestamp - Date.now();
  if (deltaMs <= 0) return "Expired";
  const totalMinutes = Math.ceil(deltaMs / (60 * 1000));
  if (totalMinutes < 60) return `${totalMinutes} min left`;
  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours} hr left`;
  return `${Math.ceil(totalHours / 24)} days left`;
}

function badgeClassName(status?: string | null) {
  switch (String(status || "").toLowerCase()) {
    case "approved":
    case "active":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "pending":
    case "request_pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "denied":
    case "revoked":
    case "cancelled":
      return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "expired":
      return "border-border/70 bg-background/80 text-muted-foreground";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function entrySummary(entry: ConsentCenterEntry) {
  if (entry.additional_access_summary) return entry.additional_access_summary;
  if (entry.scope_description) return entry.scope_description;
  if (entry.reason) return entry.reason;
  if (entry.kind === "invite") return "Invitation waiting for investor approval.";
  return entry.scope || "Consent request";
}

function toPendingConsent(entry: ConsentCenterEntry): PendingConsent {
  const issuedAt = typeof entry.issued_at === "number" ? entry.issued_at : Date.now();
  const approvalTimeoutAt =
    typeof entry.approval_timeout_at === "number"
      ? entry.approval_timeout_at
      : entry.expires_at && typeof entry.expires_at === "number"
        ? entry.expires_at
        : undefined;

  return {
    id: entry.request_id || entry.id,
    developer: entry.counterpart_label || "Requester",
    developerImageUrl: entry.counterpart_image_url || undefined,
    developerWebsiteUrl: entry.counterpart_website_url || undefined,
    scope: entry.scope || "",
    scopeDescription: entry.scope_description || undefined,
    requestedAt: issuedAt,
    approvalTimeoutAt,
    reason: entry.reason || undefined,
    requestUrl: entry.request_url || undefined,
    isScopeUpgrade: Boolean(entry.is_scope_upgrade),
    existingGrantedScopes: entry.existing_granted_scopes || undefined,
    additionalAccessSummary: entry.additional_access_summary || undefined,
    metadata: entry.metadata || undefined,
  };
}

function ConsentEntryRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ConsentCenterEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-[18px] border px-4 py-4 text-left transition-colors",
        selected
          ? "border-sky-500/30 bg-sky-500/6"
          : "border-transparent bg-transparent hover:border-border/60 hover:bg-muted/35"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {entry.counterpart_label || "Requester"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {entry.counterpart_email || entry.counterpart_secondary_label || "Hushh connection"}
          </p>
        </div>
        <Badge className={cn("shrink-0 capitalize", badgeClassName(entry.status))}>
          {formatStatus(entry.status)}
        </Badge>
      </div>
      <p className="mt-3 line-clamp-2 text-sm leading-6 text-foreground/84">{entrySummary(entry)}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {entry.scope ? <span>{entry.scope_description || entry.scope}</span> : null}
        {entry.expires_at ? <span>{formatRelative(entry.expires_at)}</span> : null}
        {entry.issued_at ? <span>{formatDate(entry.issued_at)}</span> : null}
      </div>
    </button>
  );
}

function ConsentEntryDetail({
  actor,
  entry,
  onApprove,
  onDeny,
  onRevoke,
}: {
  actor: ConsentCenterActor;
  entry: ConsentCenterEntry | null;
  onApprove: (entry: ConsentCenterEntry) => void;
  onDeny: (entry: ConsentCenterEntry) => void;
  onRevoke: (entry: ConsentCenterEntry) => void;
}) {
  if (!entry) {
    return (
      <SettingsGroup
        embedded
        title="Select a request"
        description="Choose an item from the list to review its details and available actions."
      >
        <SettingsRow title="Nothing selected yet" description="Pending, active, and previous items open here." />
      </SettingsGroup>
    );
  }

  const requestRoute =
    actor === "ria" && entry.counterpart_id
      ? buildRiaWorkspaceRoute(entry.counterpart_id)
      : null;

  return (
    <div className="space-y-4">
      <SettingsGroup
        embedded
        title={entry.counterpart_label || "Requester"}
        description={entrySummary(entry)}
      >
        <SettingsRow
          title="Status"
          description={formatStatus(entry.status)}
        />
        <SettingsRow
          title="Email or identity"
          description={
            entry.counterpart_email ||
            entry.counterpart_secondary_label ||
            "Available in technical details"
          }
        />
        <SettingsRow
          title="Scope"
          description={entry.scope_description || entry.scope || "Not provided"}
        />
        <SettingsRow
          title="Requested at"
          description={formatDate(entry.issued_at) || "Unavailable"}
        />
        <SettingsRow
          title="Expires"
          description={
            formatDate(entry.expires_at) || formatRelative(entry.expires_at) || "No expiry"
          }
        />
        {entry.reason ? <SettingsRow title="Reason" description={entry.reason} /> : null}
      </SettingsGroup>

      <SettingsGroup embedded title="Actions" description="Only the next relevant actions are shown here.">
        {entry.kind === "incoming_request" && entry.status === "pending" ? (
          <>
            <SettingsRow
              title="Approve request"
              description="Grant the requested slice with your chosen vault-backed export."
              trailing={
                <Button variant="blue-gradient" effect="fill" size="sm" onClick={() => onApprove(entry)}>
                  Approve
                </Button>
              }
            />
            <SettingsRow
              title="Deny request"
              description="Decline the request without opening access."
              trailing={
                <Button variant="none" effect="fade" size="sm" onClick={() => onDeny(entry)}>
                  Deny
                </Button>
              }
            />
          </>
        ) : null}

        {entry.kind === "active_grant" && entry.scope ? (
          <SettingsRow
            title="Revoke active access"
            description="Immediately stop this grant and keep the audit trail intact."
            trailing={
              <Button variant="none" effect="fade" size="sm" onClick={() => onRevoke(entry)}>
                Revoke
              </Button>
            }
          />
        ) : null}

        {entry.request_url ? (
          <SettingsRow
            title="Open request link"
            description="Jump to the original request or disclosure surface."
            trailing={
              <Button asChild variant="none" effect="fade" size="sm">
                <Link href={entry.request_url}>
                  Open
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            }
          />
        ) : null}

        {requestRoute ? (
          <SettingsRow
            title="Open relationship workspace"
            description="Review the advisor relationship and the latest granted access."
            trailing={
              <Button asChild variant="none" effect="fade" size="sm">
                <Link href={requestRoute}>Open workspace</Link>
              </Button>
            }
          />
        ) : null}
      </SettingsGroup>

      <details className="rounded-[22px] border border-border/60 bg-background/72 px-4 py-4">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Technical details
        </summary>
        <div className="mt-4 space-y-4 text-sm text-muted-foreground">
          {entry.technical_identity?.user_id ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em]">User ID</p>
              <p className="mt-1 break-all">{entry.technical_identity.user_id}</p>
            </div>
          ) : null}
          {entry.request_id ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em]">Request ID</p>
              <p className="mt-1 break-all">{entry.request_id}</p>
            </div>
          ) : null}
          {entry.scope ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em]">Scope code</p>
              <p className="mt-1 break-all">{entry.scope}</p>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

export function ConsentCenterPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { activePersona } = usePersonaState();
  const { pendingCount } = useConsentNotificationState();
  const pendingShortcutCount = usePendingConsentCount();
  const defaultActor: ConsentCenterActor = activePersona === "ria" ? "ria" : "investor";
  const actor = normalizeActor(searchParams.get("actor"), defaultActor);
  const tab = resolveConsentTab(searchParams);
  const managerView =
    searchParams.get("view") === "incoming" || searchParams.get("view") === "outgoing"
      ? searchParams.get("view")
      : actor === "ria"
        ? "outgoing"
        : "incoming";
  const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  const selectedId = searchParams.get("requestId") || searchParams.get("selected");
  const [searchValue, setSearchValue] = useState(searchParams.get("q") || "");
  const deferredQuery = useDeferredValue(searchValue.trim());
  const [mutationTick, setMutationTick] = useState(0);

  useEffect(() => {
    const current = searchParams.get("q") || "";
    if (current !== searchValue) {
      setSearchValue(current);
    }
  }, [searchParams, searchValue]);

  useEffect(() => {
    const handleAction = () => setMutationTick((value) => value + 1);
    window.addEventListener("consent-action-complete", handleAction);
    return () => window.removeEventListener("consent-action-complete", handleAction);
  }, []);

  const { handleApprove, handleDeny, handleRevoke } = useConsentActions({
    userId: user?.uid,
    onActionComplete: () => setMutationTick((value) => value + 1),
  });

  const idTokenLoader = async () => user?.getIdToken();

  const summaryResource = useStaleResource({
    cacheKey: user?.uid ? `consent_center_summary_${user.uid}_${actor}` : "consent_center_summary_guest",
    enabled: Boolean(user?.uid),
    load: async () => {
      const idToken = await idTokenLoader();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.getSummary({
        idToken,
        userId: user.uid,
        actor,
        force: mutationTick > 0,
      });
    },
  });

  const listResource = useStaleResource({
    cacheKey: user?.uid
      ? `consent_center_list_${user.uid}_${actor}_${tab}_${deferredQuery}_${page}_20_${mutationTick}`
      : "consent_center_list_guest",
    enabled: Boolean(user?.uid),
    load: async () => {
      const idToken = await idTokenLoader();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.listEntries({
        idToken,
        userId: user.uid,
        actor,
        surface: tab,
        q: deferredQuery,
        page,
        limit: 20,
        force: mutationTick > 0,
      });
    },
  });

  const items = useMemo(
    () => filterEntriesForTab(listResource.data?.items || [], tab),
    [listResource.data?.items, tab]
  );
  const selectedEntry = useMemo(() => {
    if (!items.length) return null;
    if (selectedId) {
      return (
        items.find((item) => item.request_id === selectedId || item.id === selectedId) ??
        items[0] ??
        null
      );
    }
    return items[0] ?? null;
  }, [items, selectedId]);

  const setParam = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (!value) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const pageEyebrow = actor === "ria" ? "RIA" : "Investor";
  const pageDescription =
    actor === "ria"
      ? "Outgoing requests, active grants, and prior investor decisions stay in one consent manager."
      : managerView === "outgoing"
        ? "Outgoing consent activity and grants stay grouped in one place."
        : "Incoming requests, active grants, and prior decisions stay grouped in one place.";

  return (
    <AppPageShell as="main" width="content" className="pb-28">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow={pageEyebrow}
          title="Consent manager"
          description={pageDescription}
          icon={ShieldCheck}
          actions={
            <Badge className={cn("border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300")}>
              {actor === "investor" ? pendingShortcutCount : pendingCount} pending
            </Badge>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack>
          <section className="space-y-4" data-testid="consent-manager-primary">
            <SettingsSegmentedTabs
              value={tab}
              onValueChange={(value) => setParam({ tab: value, page: "1", requestId: null })}
              options={[
                {
                  value: "pending",
                  label: `Pending (${summaryResource.data?.counts.pending ?? 0})`,
                },
                {
                  value: "active",
                  label: `Active (${summaryResource.data?.counts.active ?? 0})`,
                },
                {
                  value: "previous",
                  label: `Previous (${summaryResource.data?.counts.previous ?? 0})`,
                },
              ]}
            />

            <SettingsGroup embedded>
              <div className="px-4 py-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchValue}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSearchValue(next);
                      setParam({ q: next || null, page: "1" });
                    }}
                    placeholder={`Search ${tab} by name, email, scope, or reason`}
                    className="pl-9"
                  />
                </div>
                {(listResource.loading || listResource.refreshing) && items.length > 0 ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Refreshing from the latest consent state…
                  </div>
                ) : null}
              </div>
            </SettingsGroup>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
              <section data-testid="consent-manager-list">
                <SettingsGroup embedded>
                  <div className="space-y-2 px-2 py-2">
                    {listResource.loading && items.length === 0 ? (
                      <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading consent entries…
                      </div>
                    ) : null}
                    {!listResource.loading && items.length === 0 ? (
                      <div className="px-3 py-8 text-sm text-muted-foreground">
                        No {tab} entries match this view right now.
                      </div>
                    ) : null}
                    {items.map((entry) => (
                      <ConsentEntryRow
                        key={entry.id}
                        entry={entry}
                        selected={selectedEntry?.id === entry.id}
                        onSelect={() =>
                          setParam({
                            requestId: entry.request_id || entry.id,
                          })
                        }
                      />
                    ))}
                  </div>

                  {listResource.data ? (
                    <div className="flex items-center justify-between border-t border-border/60 px-4 py-4 text-sm text-muted-foreground">
                      <span>
                        Page {listResource.data.page} of{" "}
                        {Math.max(1, Math.ceil(listResource.data.total / listResource.data.limit))}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="none"
                          effect="fade"
                          size="sm"
                          disabled={page <= 1}
                          onClick={() => setParam({ page: String(Math.max(1, page - 1)) })}
                        >
                          Previous
                        </Button>
                        <Button
                          variant="none"
                          effect="fade"
                          size="sm"
                          disabled={!listResource.data.has_more}
                          onClick={() => setParam({ page: String(page + 1) })}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </SettingsGroup>
              </section>

              <section data-testid="consent-manager-detail">
                <ConsentEntryDetail
                  actor={actor}
                  entry={selectedEntry}
                  onApprove={(entry) => void handleApprove(toPendingConsent(entry))}
                  onDeny={(entry) => void handleDeny(entry.request_id || entry.id)}
                  onRevoke={(entry) => {
                    if (!entry.scope) return;
                    void handleRevoke(entry.scope);
                  }}
                />
              </section>
            </div>
          </section>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
