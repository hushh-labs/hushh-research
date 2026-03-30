"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { ReadonlyURLSearchParams } from "next/navigation";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, Search, ShieldCheck } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import { useConsentActions, type PendingConsent } from "@/lib/consent";
import { usePersonaState } from "@/lib/persona/persona-context";
import {
  CONSENT_CENTER_PAGE_SIZE,
  ConsentCenterService,
  type ConsentCenterActor,
  type ConsentCenterEntry,
  type ConsentCenterPageListResponse,
  type ConsentCenterPageSummary,
} from "@/lib/services/consent-center-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { Button } from "@/lib/morphy-ux/button";
import { buildRiaWorkspaceRoute } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

type ConsentTab = "pending" | "active" | "previous";

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

function resolveCounterpartLabel(entry: ConsentCenterEntry) {
  return (
    entry.counterpart_label ||
    entry.counterpart_email ||
    entry.counterpart_secondary_label ||
    entry.counterpart_id ||
    "Requester"
  );
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
    developer: resolveCounterpartLabel(entry),
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
            {resolveCounterpartLabel(entry)}
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
        title={resolveCounterpartLabel(entry)}
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

      {entry.technical_identity?.user_id || entry.request_id || entry.scope ? (
        <SettingsGroup
          embedded
          title="Technical details"
          description="Stable identifiers stay available here without cluttering the primary review flow."
        >
          {entry.technical_identity?.user_id ? (
            <SettingsRow title="User ID" description={entry.technical_identity.user_id} />
          ) : null}
          {entry.request_id ? <SettingsRow title="Request ID" description={entry.request_id} /> : null}
          {entry.scope ? <SettingsRow title="Scope code" description={entry.scope} /> : null}
        </SettingsGroup>
      ) : null}
    </div>
  );
}

export function ConsentCenterPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { activePersona } = usePersonaState();
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
  const summaryCacheKey = user?.uid
    ? CACHE_KEYS.CONSENT_CENTER_SUMMARY(user.uid, actor)
    : "consent_center_summary_guest";
  const listCacheKey = user?.uid
    ? CACHE_KEYS.CONSENT_CENTER_LIST(
        user.uid,
        actor,
        tab,
        deferredQuery,
        page,
        CONSENT_CENTER_PAGE_SIZE
      )
    : "consent_center_list_guest";
  const [retainedSummary, setRetainedSummary] = useState<{
    key: string;
    data: ConsentCenterPageSummary;
  } | null>(null);
  const [retainedList, setRetainedList] = useState<{
    key: string;
    data: ConsentCenterPageListResponse;
  } | null>(null);

  useEffect(() => {
    const current = searchParams.get("q") || "";
    if (current !== searchValue) {
      setSearchValue(current);
    }
  }, [searchParams, searchValue]);

  useEffect(() => {
    const handleAction = () => setMutationTick((value) => value + 1);
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleAction);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleAction);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleAction);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleAction);
    };
  }, []);

  const { handleApprove, handleDeny, handleRevoke } = useConsentActions({
    userId: user?.uid,
    onActionComplete: () => setMutationTick((value) => value + 1),
  });

  const idTokenLoader = async () => user?.getIdToken();

  const summaryResource = useStaleResource({
    cacheKey: summaryCacheKey,
    refreshKey: `${actor}:${mutationTick}`,
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
    cacheKey: listCacheKey,
    refreshKey: `${actor}:${tab}:${deferredQuery}:${page}:${mutationTick}`,
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
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: mutationTick > 0,
      });
    },
  });

  useEffect(() => {
    if (summaryResource.data) {
      setRetainedSummary({ key: summaryCacheKey, data: summaryResource.data });
    }
  }, [summaryCacheKey, summaryResource.data]);

  useEffect(() => {
    if (listResource.data) {
      setRetainedList({ key: listCacheKey, data: listResource.data });
    }
  }, [listCacheKey, listResource.data]);

  const summaryData =
    summaryResource.data ??
    (retainedSummary?.key === summaryCacheKey ? retainedSummary.data : null);
  const listData =
    listResource.data ?? (retainedList?.key === listCacheKey ? retainedList.data : null);
  const items = useMemo(() => listData?.items || [], [listData?.items]);
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
              {summaryData?.counts.pending ?? 0} pending
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
                  label: `Pending (${summaryData?.counts.pending ?? 0})`,
                },
                {
                  value: "active",
                  label: `Active (${summaryData?.counts.active ?? 0})`,
                },
                {
                  value: "previous",
                  label: `Previous (${summaryData?.counts.previous ?? 0})`,
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
                  <div className="mt-3 text-xs text-muted-foreground">
                    Refreshing from the latest consent state…
                  </div>
                ) : null}
              </div>
            </SettingsGroup>

            <section data-testid="consent-manager-list">
              <SettingsGroup embedded>
                <div className="space-y-2 px-2 py-2">
                  {listResource.loading && items.length === 0 ? (
                    <div className="px-3 py-6 text-sm text-muted-foreground">
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

                {listData ? (
                  <PaginatedListFooter
                    page={listData.page}
                    limit={listData.limit}
                    total={listData.total}
                    hasMore={listData.has_more}
                    onPrevious={() => setParam({ page: String(Math.max(1, page - 1)) })}
                    onNext={() => setParam({ page: String(page + 1) })}
                  />
                ) : null}
              </SettingsGroup>
            </section>
          </section>
        </SurfaceStack>
      </AppPageContentRegion>

      <SettingsDetailPanel
        open={Boolean(selectedId)}
        onOpenChange={(open) => {
          if (!open) {
            setParam({ requestId: null });
          }
        }}
        title={selectedEntry ? resolveCounterpartLabel(selectedEntry) : "Consent details"}
        description={
          selectedEntry
            ? entrySummary(selectedEntry)
            : "Choose a consent entry from the list to review details and next actions."
        }
      >
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
      </SettingsDetailPanel>
    </AppPageShell>
  );
}
