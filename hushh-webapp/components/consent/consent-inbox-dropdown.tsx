"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, Shield } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TOP_SHELL_DROPDOWN_BODY_CLASSNAME,
  TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME,
  TOP_SHELL_DROPDOWN_FOOTER_CLASSNAME,
  TOP_SHELL_DROPDOWN_HEADER_CLASSNAME,
} from "@/components/app-ui/top-shell-dropdown";
import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import {
  buildConsentCenterHref,
  buildRiaConsentManagerHref,
} from "@/lib/consent/consent-sheet-route";
import { Button } from "@/lib/morphy-ux/button";
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
import { cn } from "@/lib/utils";

function entrySummary(entry: ConsentCenterEntry) {
  if (entry.additional_access_summary) return entry.additional_access_summary;
  if (entry.scope_description) return entry.scope_description;
  if (entry.reason) return entry.reason;
  if (entry.kind === "invite") return "Invitation waiting for investor approval.";
  return entry.scope || "Consent request";
}

function entryLabel(entry: ConsentCenterEntry) {
  return (
    entry.counterpart_label ||
    entry.counterpart_email ||
    entry.counterpart_secondary_label ||
    entry.counterpart_id ||
    "Requester"
  );
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

function entryHref(actor: ConsentCenterActor, entry: ConsentCenterEntry) {
  const requestId = entry.request_id || entry.id;
  return actor === "ria"
    ? buildRiaConsentManagerHref("pending", { requestId })
    : buildConsentCenterHref("pending", { actor: "investor", requestId });
}

function managerHref(actor: ConsentCenterActor) {
  return actor === "ria"
    ? buildRiaConsentManagerHref("pending")
    : buildConsentCenterHref("pending", { actor: "investor" });
}

export function ConsentInboxDropdown({
  triggerClassName,
}: {
  triggerClassName: string;
}) {
  const { user } = useAuth();
  const { activePersona } = usePersonaState();
  const actor: ConsentCenterActor = activePersona === "ria" ? "ria" : "investor";
  const [open, setOpen] = useState(false);
  const [mutationTick, setMutationTick] = useState(0);
  const pendingPreviewLimit = 5;

  const summaryCacheKey = user?.uid
    ? CACHE_KEYS.CONSENT_CENTER_SUMMARY(user.uid, actor)
    : "consent_center_summary_guest";
  const pendingListCacheKey = user?.uid
    ? CACHE_KEYS.CONSENT_CENTER_LIST(user.uid, actor, "pending", "", 1, CONSENT_CENTER_PAGE_SIZE)
    : "consent_center_list_guest";

  const [retainedSummary, setRetainedSummary] = useState<{
    key: string;
    data: ConsentCenterPageSummary;
  } | null>(null);
  const [retainedPendingList, setRetainedPendingList] = useState<{
    key: string;
    data: ConsentCenterPageListResponse;
  } | null>(null);

  useEffect(() => {
    const handleMutation = () => setMutationTick((value) => value + 1);
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    };
  }, []);

  const summaryResource = useStaleResource({
    cacheKey: summaryCacheKey,
    refreshKey: `${actor}:${mutationTick}`,
    enabled: Boolean(user?.uid),
    load: async () => {
      const idToken = await user?.getIdToken();
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

  const summaryData =
    summaryResource.data ??
    (retainedSummary?.key === summaryCacheKey ? retainedSummary.data : null);
  const pendingCount = summaryData?.counts.pending ?? 0;

  const pendingListResource = useStaleResource({
    cacheKey: pendingListCacheKey,
    refreshKey: `${actor}:${mutationTick}:${pendingCount}`,
    enabled: Boolean(user?.uid) && pendingCount > 0,
    load: async () => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.listEntries({
        idToken,
        userId: user.uid,
        actor,
        surface: "pending",
        page: 1,
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
    if (pendingListResource.data) {
      setRetainedPendingList({ key: pendingListCacheKey, data: pendingListResource.data });
    }
  }, [pendingListCacheKey, pendingListResource.data]);

  const pendingListData =
    pendingListResource.data ??
    (retainedPendingList?.key === pendingListCacheKey ? retainedPendingList.data : null);

  const items =
    pendingCount > 0 ? (pendingListData?.items || []).slice(0, pendingPreviewLimit) : [];
  const hasAdditionalPending = (pendingListData?.total ?? 0) > items.length;
  const isInitialSummaryLoad = summaryResource.loading && !summaryData;
  const isInitialPendingListLoad = pendingCount > 0 && pendingListResource.loading && items.length === 0;
  const primaryHref = useMemo(() => managerHref(actor), [actor]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            triggerClassName,
            "inline-flex h-10 w-10 items-center justify-center"
          )}
          aria-label="Open consent inbox"
        >
          <Shield className="h-5 w-5" />
          {pendingCount > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold text-white">
              {pendingCount}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className={TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME}
      >
        <div className={TOP_SHELL_DROPDOWN_HEADER_CLASSNAME}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Pending consents</p>
              <p className="text-[11px] text-muted-foreground">
                {actor === "ria"
                  ? "Open requests and invites for your active advisor persona."
                  : "Actionable incoming requests for your active investor persona."}
              </p>
            </div>
            {summaryResource.loading || summaryResource.refreshing ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </div>

        <div className={TOP_SHELL_DROPDOWN_BODY_CLASSNAME}>
          {isInitialSummaryLoad || isInitialPendingListLoad ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">
              Loading pending consents…
            </div>
          ) : null}

          {!isInitialSummaryLoad && !isInitialPendingListLoad && items.length === 0 ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">
              No pending consents right now.
            </div>
          ) : null}

          {items.length > 0 ? (
            <div className="divide-y divide-border/45">
              {items.map((entry) => (
                <Link
                  key={entry.id}
                  href={entryHref(actor, entry)}
                  prefetch={false}
                  onClick={() => setOpen(false)}
                  className="block rounded-[14px] px-3 py-3 transition-colors hover:bg-muted/36"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium tracking-tight text-foreground">
                        {entryLabel(entry)}
                      </p>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-[1.45] text-muted-foreground">
                        {entrySummary(entry)}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatRelative(entry.expires_at) ||
                        entry.counterpart_email ||
                        entry.counterpart_secondary_label ||
                        ""}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        <div className={TOP_SHELL_DROPDOWN_FOOTER_CLASSNAME}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button asChild variant="none" effect="fade" size="sm">
              <Link href={primaryHref} prefetch={false} onClick={() => setOpen(false)}>
                Open consent manager
              </Link>
            </Button>
            {hasAdditionalPending ? (
              <Button asChild variant="none" effect="fade" size="sm">
                <Link href={primaryHref} prefetch={false} onClick={() => setOpen(false)}>
                  View all pending
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
