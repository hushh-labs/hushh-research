"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  BadgeCheck,
  BookUser,
  Check,
  ChevronDown,
  Loader2,
  Lock,
  RefreshCw,
  Search as SearchIcon,
  Share2,
  X,
} from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NearbyDirectories } from "@/components/connect/nearby-directories";
import { PageHeader } from "@/components/app-ui/page-sections";
import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectCirclesTab } from "@/components/connect/circles/connect-circles-tab";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { buildInviteToOneShare } from "@/lib/connect/invite-to-one";
import {
  isShareCancellationError,
  ShareUnavailableError,
  shareLink,
} from "@/lib/share/share-link";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRequireAuth } from "@/hooks/use-auth";
import { ContactSyncResultsSheet } from "@/components/one-location/contact-sync-results-sheet";
import { useContactSync } from "@/lib/contacts/use-contact-sync";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { isNative } from "@/lib/capacitor/platform";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { buildPersonProfileRoute, ROUTES } from "@/lib/navigation/routes";
import {
  CONNECT_CIRCLE_ACTION_PARAM,
  CONNECT_CIRCLE_ID_PARAM,
  CONNECT_SEARCH_QUERY_PARAM,
  CONNECT_SURFACE_PARAM,
  connectCircleTaskTitle,
  isFocusedConnectCircleTask,
  readConnectCircleAction,
  readConnectSurface,
  type ConnectSurface,
} from "@/lib/navigation/connect-routes";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button } from "@/lib/morphy-ux/button";
import {
  ConnectionsService,
  type ConnectionAudience,
  type ConnectionPage,
  type ConnectionRelationship,
  type ConnectionScopeCatalog,
  type ConnectionSummaryEntry,
  type DirectoryAudience,
  type DirectoryPerson,
} from "@/lib/services/connections-service";
import { relationshipCta } from "@/lib/connections/relationship-label";
import { TOP_SHELL_TAB_REGISTRY } from "@/lib/navigation/top-shell-tabs";
import {
  VOICE_CONFIRM_DATA_KEY,
  VOICE_DISAMBIGUATION_DATA_KEY,
} from "@/lib/voice/voice-action-card";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { getDirectoryPersonDescription } from "./directory-person-label";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import {
  CONNECT_PAGER_BUTTON_CLASSNAME,
  CONNECT_SEARCH_INPUT_CLASSNAME,
  CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME,
  CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME,
  CONNECT_SEARCH_PLACEHOLDER,
} from "./connect-search-layout";
import { CONNECT_WEB_DIRECTORY_POPOVER_CLASSNAME } from "./connect-surface-layout";
import { cn } from "@/lib/utils";
import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
import {
  CONNECT_DESKTOP_CONNECTION_LIST_CLASSNAME,
  CONNECT_PAGE_CONTENT_CLASSNAME,
  CONNECT_WRAPPING_TEXT_CLASSNAME,
  CONNECT_WRAPPING_TITLE_ROW_CLASSNAME,
} from "./connect-surface-layout";

type ConnectTab = "people" | "advisors" | "nearby";

/**
 * "RIAs" rather than "Advisors", which is the plainer word.
 *
 * Around you already owns a sub-tab called Advisors, and both strips are on
 * screen together whenever that tab is open -- two controls with one name, a
 * few pixels apart, meaning different things: every registered adviser on
 * Hussh, and the advisers near this phone right now. The regulatory term is the
 * one thing that cannot be confused with "advisers nearby", and it is the word
 * the people who hold these profiles use for themselves.
 */
/**
 * The route-level axis: the directory hub, or the groups people belong to.
 *
 * Carried in `?tab=` because a circle detail is a place you can be sent, and a
 * hub tab that only exists in `useState` cannot be linked to or returned to.
 */
const CONNECT_SEARCH_QUERY_STORAGE_KEY = "hushh:connect:people-search-query";

// The People search box is local state, not URL state (unlike surface/
// circle flow, which live in the query string) -- typed text does not
// belong in browser history. But that means leaving to a person's detail
// screen and using the shared back control, which remounts this page, used
// to drop it: the box came back empty even though the person had just been
// searching. sessionStorage survives the remount without turning a keystroke
// into a navigable state. Split out as named functions (rather than inline
// in the component) so the storage contract is unit-testable without
// rendering the full page.
export function readStoredConnectSearchQuery(): string {
  if (typeof window === "undefined") return "";
  try {
    return (
      window.sessionStorage.getItem(CONNECT_SEARCH_QUERY_STORAGE_KEY) ?? ""
    );
  } catch {
    return "";
  }
}

export function writeStoredConnectSearchQuery(query: string): void {
  if (typeof window === "undefined") return;
  try {
    if (query) {
      window.sessionStorage.setItem(CONNECT_SEARCH_QUERY_STORAGE_KEY, query);
    } else {
      window.sessionStorage.removeItem(CONNECT_SEARCH_QUERY_STORAGE_KEY);
    }
  } catch {
    // Best-effort: a blocked sessionStorage (private mode) just means the
    // query is not restored later, not a broken search.
  }
}

/**
 * The pinned header: the Connect hub strip, and nothing else.
 *
 * `--top-shell-live-height` rather than `top-0` -- the scroll root clears the
 * top bar with a spacer rather than padding, so `top-0` sticks a strip to the
 * scrollport edge, which the fixed bar overlays. Same token the feed's sticky
 * day dividers use.
 *
 * The negative inline margin is what makes the background reach the page
 * gutters. Without it, rows scroll past visibly in the 16-24px either side of a
 * header that is supposed to be covering them.
 *
 * `bg-background`, at full opacity, NOT `bg-background/85`. Fifteen percent of a
 * roster row is still a roster row: names and avatars read straight through the
 * strips at phone width, which is the "list scrolls behind the header" this
 * fixes. The blur went with it -- it has nothing left to blur, and it cost a
 * compositing layer on every scroll frame.
 *
 * `::before` continues that same material UP over `--top-fade-active`, the band
 * where the fixed top mask dissolves to fully transparent. The header pins at
 * the mask's last visible pixel, so that band is chrome-coloured at the top and
 * clear glass at the bottom -- and rows slid through it in plain sight, between
 * the bar and the strips, which is the other half of the same report. Covering
 * it means the tail dissolves over empty page instead, exactly as it does when
 * the page has not been scrolled.
 *
 * Height only under `data-pinned`: an absolutely positioned box with no height
 * and empty content is 0px tall, so the cover exists and measures nothing until
 * the header is really pinned. It has to be conditional. At rest this header
 * sits `--page-header-section-gap` below the page title -- 10px at compact
 * density -- and an unconditional 22px band would take a bite out of "Connect".
 *
 * Held by e2e/connect-sticky-header.layout.spec.ts.
 */
const CONNECT_STICKY_HEADER_CLASSNAME =
  "sticky top-[var(--top-shell-live-height,0px)] z-20 mx-[calc(var(--page-inline-gutter-standard)*-1)] space-y-3 bg-background px-[var(--page-inline-gutter-standard)] pb-3 pt-2 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:bg-background data-[pinned=true]:before:h-[calc(var(--top-fade-active,0px)+1px)] sm:space-y-4";

/**
 * The search row pins UNDER the header, not with it.
 *
 * This field searches the directory, and the directory is what sits below it --
 * `My connections` is above. Lifting it into the header would fix a control to
 * the top of a screen where the first thing under it is a list the field does
 * not filter. Pinned in place instead, it arrives exactly when its own results
 * do and stays for as long as they are on screen.
 *
 * The offset is the live top shell plus whatever the header above measured.
 *
 * Opaque for the same reason the header above it is: at 85% the directory rows
 * this field filters read straight through it as they scroll past.
 */
const CONNECT_STICKY_SEARCH_CLASSNAME =
  "sticky top-[calc(var(--top-shell-live-height,0px)+var(--connect-sticky-header-height,0px))] z-10 mx-[calc(var(--page-inline-gutter-standard)*-1)] bg-background px-[var(--page-inline-gutter-standard)] py-2";

const CONNECT_TAB_LABEL: Record<ConnectTab, string> = {
  people: "People",
  advisors: "RIAs",
  nearby: "Around you",
};

const CONNECT_SURFACE_TAB_DEFINITION = TOP_SHELL_TAB_REGISTRY.connect;

const CONNECT_DIRECTORY_TABS = (["people", "advisors", "nearby"] as const).map(
  (value) => ({ value, label: CONNECT_TAB_LABEL[value] }),
);

/**
 * Which half of the directory each tab pages through.
 *
 * The split is a server-side audience rather than a filter over the rendered
 * page, because a filter applied after the page is cut can only ever subtract
 * from a page that was already chosen wrongly: pages of uneven size, and every
 * advisor past the first one unreachable.
 *
 * People and Advisors partition the directory, so putting advisors in their own
 * tab hides nobody -- everyone findable before is still findable, in exactly
 * one of the two.
 */
const CONNECT_TAB_AUDIENCE: Record<ConnectTab, DirectoryAudience> = {
  people: "people",
  advisors: "ria",
  // Around you runs its own directories; the value is never used for it.
  nearby: "all",
};

/**
 * How many directory reads or connection writes may be in flight at once.
 *
 * A bulk action of 10 people is 10 catalog reads and then up to 10 writes, and
 * each write holds a database connection for its whole transaction. The pool is
 * 5 connections with 10 overflow, and production runs a smaller instance than
 * UAT does, so an unbounded Promise.all is the shape that exhausts it. Three at
 * a time keeps the action quick without ever being the reason a request fails.
 */
const CONNECT_REQUEST_CONCURRENCY = 3;

/** Run `task` over `items`, at most `limit` at a time, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await task(item, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * How many people the unsearched People tab offers.
 *
 * Deliberately about a screen's worth. It exists so someone who has just joined
 * and knows nobody's exact name is not staring at an empty surface — not so
 * they can browse the register, which is the thing that stops scaling.
 */
const SUGGESTED_PEOPLE_LIMIT = 20;

/**
 * How many people a page shows, and the sizes the reader can pick.
 *
 * #5020 answered "the directory is unusably long" with a fixed sample that
 * deliberately refused to page. That solved the first screenful and left no way
 * through the rest, so this replaces it with real paging: the default is still
 * a screenful, and someone who wants to scan more can say so.
 */
const DEFAULT_PAGE_SIZE = SUGGESTED_PEOPLE_LIMIT;
const CONNECT_ROW_ACTION_CLASSNAME =
  "h-8 min-h-8 rounded-2xl px-2.5 text-[14px] font-semibold leading-[18px]";
const CONNECT_INLINE_BUTTON_CLASSNAME =
  "h-8 min-h-8 rounded-2xl px-3 text-[14px] font-semibold leading-[18px]";
const CONNECT_REFRESH_BUTTON_CLASSNAME =
  "h-8 min-h-8 w-8 min-w-8 rounded-full p-0 text-muted-foreground hover:text-foreground disabled:opacity-70";

/** Maximum number of connection requests the People bulk action can send. */
const MAX_BULK_CONNECTION_REQUESTS = 10;

/**
 * Bounds on resolving ONE spoken name against the directory.
 *
 * Wide enough that the answer is about the person rather than about where
 * they happened to land in a result set, and bounded because the directory is
 * every account on Hussh — a runaway loop here would be worse than a refusal.
 * 250 rows for a single queried name is far past the point where a name is
 * still identifying anyway; beyond that, ambiguity is the honest answer.
 */
const DIRECTORY_RESOLVE_PAGE_SIZE = 50;
const DIRECTORY_RESOLVE_MAX_PAGES = 5;
const CONNECTION_PAGE_SIZE = 50;
const CONNECTION_RESOLVE_MAX_PAGES = 5;

/**
 * Match a spoken name against a list the server just returned.
 *
 * Deliberately more forgiving than `connect.send_request`'s exact
 * `localeCompare`, and deliberately narrower than the Location composer's
 * search. Someone says "Sarah", not "Sarah Chen", and refusing that is a
 * refusal the person cannot act on -- they said the name they know. But
 * matching on anything other than the NAME (headline, relationship, any other
 * recommendation text) is how a search returns a person nobody asked for.
 *
 * Exact wins outright. Only when nothing matches exactly does a prefix or
 * word-boundary match count, and every candidate is returned so the caller can
 * refuse an ambiguous one rather than picking. Nothing here decides; it
 * reports how many the words could mean.
 */
/**
 * The button one duplicate gets in the disambiguation card.
 *
 * Two rows sharing a display name are routinely in different relationship
 * states -- the screenshot that prompted this had one "Connect" and one
 * "Cancel request" -- so a single fixed label would offer at least one of them
 * an action guaranteed to be refused the moment it ran.
 *
 * Labels come from `relationshipCta`, the same source the Connect list uses, so
 * the card and the list behind it can never disagree about what a person's
 * state is called.
 *
 * Only a genuine `connect` is tappable here. `respond` is deliberately not:
 * answering someone else's invitation is a different action on a different
 * screen, and `connect.send_request` refuses it anyway -- offering it would
 * spend the person's tap to earn a refusal.
 */
function connectCandidateAffordance(relationship: ConnectionRelationship): {
  actionLabel: string;
  disabledReason: string | null;
} {
  const cta = relationshipCta(relationship);
  if (cta.action === "connect") {
    return { actionLabel: cta.label, disabledReason: null };
  }
  if (relationship === "connected") {
    return { actionLabel: cta.label, disabledReason: "Already connected" };
  }
  if (relationship === "pending_outgoing") {
    return { actionLabel: cta.label, disabledReason: "Waiting on them" };
  }
  if (relationship === "pending_incoming") {
    return { actionLabel: cta.label, disabledReason: "They asked you first" };
  }
  return { actionLabel: cta.label, disabledReason: "Not available" };
}

function matchByName<T>(
  rows: readonly T[],
  spoken: string,
  nameOf: (row: T) => string | null | undefined,
): T[] {
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      // Punctuation out, so an initial is just a letter. Directories store
      // "Abdul R." and "Abdul R" and "Abdul R,"; nobody says the full stop,
      // and leaving it in means "r." can never be recognised as the start of
      // "rashid".
      // \p{M} is kept deliberately: Devanagari and Arabic vowel signs are
      // marks, not letters, so dropping them shreds "परिवार" into "पर व र" and
      // a name written in an Indic script can never match itself.
      .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const target = normalize(spoken);
  if (!target) return [];
  const named = rows.filter(
    (row) => normalize(String(nameOf(row) ?? "")).length > 0,
  );

  const exact = named.filter(
    (row) => normalize(String(nameOf(row))) === target,
  );
  if (exact.length > 0) return exact;

  const contains = named.filter((row) => {
    const name = normalize(String(nameOf(row)));
    return name.startsWith(`${target} `) || name.split(" ").includes(target);
  });
  if (contains.length > 0) return contains;

  // Last tier: every word of the shorter name accounted for in the longer.
  //
  // Names are not stored the way people say them. Someone says "Abdul
  // Rashid" and the directory holds "Abdul R."; someone says "Abdul" and it
  // holds "Abdul Kumar Rashid". Neither is exact, neither is a prefix, and
  // neither contains the other as a whole word -- so both failed, about a
  // person visible on screen.
  //
  // Word-level and prefix-wise, so "r" matches "rashid" and an initial does
  // its job, but "abdul" can never match "abdullah" as a whole spoken name
  // because the tiers above would have claimed a better candidate first.
  const targetWords = target.split(" ").filter(Boolean);
  return named.filter((row) => {
    const nameWords = normalize(String(nameOf(row)))
      .split(" ")
      .filter(Boolean);
    const [shorter, longer] =
      targetWords.length <= nameWords.length
        ? [targetWords, nameWords]
        : [nameWords, targetWords];
    if (shorter.length === 0) return false;
    const remaining = [...longer];
    return shorter.every((word) => {
      const hit = remaining.findIndex(
        (candidate) => candidate.startsWith(word) || word.startsWith(candidate),
      );
      if (hit === -1) return false;
      // Consumed, so two spoken words cannot both claim the same stored one.
      remaining.splice(hit, 1);
      return true;
    });
  });
}

async function resolveConnectionForVoice({
  idToken,
  spokenName,
  connectionId,
}: {
  idToken: string;
  spokenName: string;
  connectionId: string;
}): Promise<{ matches: ConnectionSummaryEntry[]; complete: boolean }> {
  const rows: ConnectionSummaryEntry[] = [];
  for (let page = 1; page <= CONNECTION_RESOLVE_MAX_PAGES; page += 1) {
    const result = await ConnectionsService.listConnectionsPage({
      idToken,
      page,
      limit: CONNECTION_PAGE_SIZE,
      query: spokenName,
      audience: "all",
    });
    rows.push(...result.items);
    if (connectionId) {
      const exact = rows.find((row) => row.connectionId === connectionId);
      if (exact) return { matches: [exact], complete: true };
    }
    if (!result.hasMore) {
      return {
        matches: connectionId
          ? []
          : matchByName(rows, spokenName, (entry) => entry.displayName),
        complete: true,
      };
    }
  }
  // A name may have another duplicate beyond the bounded window. Choosing one
  // would make pagination an authority decision, so voice refuses safely.
  return { matches: [], complete: false };
}

export default function ConnectPageClient() {
  const { user } = useRequireAuth();
  const router = useRouter();

  const searchParams = useSearchParams();
  /**
   * The route-backed Connect surface, from `?tab=`.
   *
   * Anything unrecognised reads as "all" rather than throwing a 404 at
   * somebody who mistyped a link, and the default is not written to the URL on
   * mount -- that would eat one `router.back()` step for every arrival.
   */
  const surface: ConnectSurface = readConnectSurface(
    searchParams.get(CONNECT_SURFACE_PARAM),
  );
  /** Which Circle flow, if any, the URL is asking for. Part of the scroll key
   *  below, because opening one is a new screen even though the path is not. */
  const circleFlowAction = readConnectCircleAction(
    searchParams.get(CONNECT_CIRCLE_ACTION_PARAM),
  );
  const circleFlowId = searchParams.get(CONNECT_CIRCLE_ID_PARAM) ?? "";
  const isFocusedCircleTask = isFocusedConnectCircleTask(
    surface,
    circleFlowAction,
    circleFlowId,  );

  // Every navigation on this page passes `scroll: false`, because the surface
  // strip and the Circle flows are query-only states that must not jump the
  // page. The cost is that nothing resets scroll either: the shell keys its
  // own reset on the pathname, which never changes here, so a long people list
  // scrolled halfway down handed that offset to the circles list, and to every
  // Circle flow opened after it. The Location hub hit this and fixed it the
  // same way.
  useScrollReset(`${surface}:${circleFlowAction ?? ""}:${circleFlowId}`, {
    behavior: "auto",
  });

  const [tab, setTab] = useState<ConnectTab>("people");
  /**
   * What the Circles tab is doing, reported up.
   *
   * The native audit and the voice layer both describe "the screen", and the
   * screen is whichever surface is showing. Deriving either from the directory
   * while Circles is open would report an empty directory as the state of a
   * tab that is not rendering one.
   */
  // Bumped whenever something outside the Circles tab changes a Circle or a
  // relationship, so an open roster re-reads instead of waiting for a manual
  // refresh -- the request sent from a member row is the case that showed.
  const [circleRefreshToken, setCircleRefreshToken] = useState(0);
  const [circlesState, setCirclesState] = useState<{
    loading: boolean;
    error: string | null;
    count: number;
  }>({ loading: true, error: null, count: 0 });
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const connectStackRef = useRef<HTMLDivElement | null>(null);
  const stickyHeaderRef = useRef<HTMLDivElement | null>(null);
  const stickyPinSentinelRef = useRef<HTMLDivElement | null>(null);
  const directoryMenuRef = useRef<HTMLDivElement | null>(null);
  const directoryMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const loadMoreDirectoryRef = useRef<HTMLDivElement | null>(null);
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const useWebDirectoryPopover = !isNative();  const searchQueryParam = (searchParams.get(CONNECT_SEARCH_QUERY_PARAM) ?? "")
    .trim()
    .slice(0, 160);
  const [query, setQuery] = useState<string>(
    () => searchQueryParam || readStoredConnectSearchQuery(),
  );
  const appliedSearchQueryParamRef = useRef(searchQueryParam || null);
  useEffect(() => {
    if (
      searchQueryParam &&
      appliedSearchQueryParamRef.current !== searchQueryParam
    ) {
      appliedSearchQueryParamRef.current = searchQueryParam;
      setQuery(searchQueryParam);
    }
  }, [searchQueryParam]);
  useEffect(() => {
    writeStoredConnectSearchQuery(query);
  }, [query]);
  const debouncedQuery = useDebouncedValue(query, 300);

  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [connections, setConnections] = useState<ConnectionSummaryEntry[]>([]);
  const [connectionsPage, setConnectionsPage] = useState(1);
  const [connectionsHasMore, setConnectionsHasMore] = useState(false);
  const [connectionsTotalCount, setConnectionsTotalCount] = useState(0);
  const [connectionsLoadingMore, setConnectionsLoadingMore] = useState(false);
  const [connectionsRefreshingFirstPage, setConnectionsRefreshingFirstPage] =
    useState(false);
  const connectionsRequestRef = useRef(0);
  const connectionsFirstPageRequestRef = useRef<number | null>(null);
  const [outgoingRequestIds, setOutgoingRequestIds] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = DEFAULT_PAGE_SIZE;
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  /**
   * Publish the pinned header's height so the search row can sit under it.
   *
   * Measured rather than assumed: the strip's own height moves with the type
   * scale and the breakpoint. A hard-coded offset is right at exactly one
   * width.
   *
   * Written to the page's own stack, not `documentElement`, so it inherits down
   * to the search row and to nothing else, and leaves with the page.
   */
  useEffect(() => {
    const header = stickyHeaderRef.current;
    const stack = connectStackRef.current;
    if (!header || !stack) return;
    const publish = () => {
      stack.style.setProperty(
        "--connect-sticky-header-height",
        `${Math.ceil(header.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    return () => observer.disconnect();
  }, [surface]);
  /**
   * Say whether the header is actually pinned, so its cover can be conditional.
   *
   * The cover is a band of page background continuing UP from the header over
   * `--top-fade-active` -- the strip where the fixed top mask dissolves to
   * nothing and rows were sliding through it in plain sight. Pinned, that band
   * belongs to the chrome. At rest it is the gap under the "Connect" title,
   * `--page-header-section-gap`, which is 10px at this page's density -- so an
   * unconditional cover would sit on the title instead of on the mask's tail.
   *
   * An observer rather than a scroll handler: this fires twice per visit, at
   * the pin boundary, instead of measuring on every frame the way the top app
   * bar's own collapse tracking has to.
   *
   * `rootMargin` is the header's resolved `top`, read back rather than
   * recomputed. `--top-shell-live-height` is a calc of six tokens declared at
   * route-shell scope; anything here that re-derived it would be a second copy
   * to keep in step with `signed-in-shell-content-offset.ts`.
   */
  useEffect(() => {
    const header = stickyHeaderRef.current;
    const sentinel = stickyPinSentinelRef.current;
    if (!header || !sentinel) return;
    if (typeof IntersectionObserver === "undefined") return;
    const scrollRoot = document.querySelector<HTMLElement>(
      '[data-app-scroll-root="true"]',
    );
    let observer: IntersectionObserver | null = null;
    const attach = () => {
      observer?.disconnect();
      const pinnedAt = Math.max(
        0,
        Math.round(Number.parseFloat(getComputedStyle(header).top) || 0),
      );
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          header.dataset.pinned = entry.isIntersecting ? "false" : "true";
        },
        { root: scrollRoot, rootMargin: `-${pinnedAt}px 0px 0px 0px` },
      );
      observer.observe(sentinel);
    };
    attach();
    // The offset moves with the breakpoint and with the safe-area inset, and a
    // rotation changes both at once.
    window.addEventListener("resize", attach);
    return () => {
      window.removeEventListener("resize", attach);
      observer?.disconnect();
    };
  }, [surface]);

  useEffect(() => {
    if (useWebDirectoryPopover) return;
    if (!directoryMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const menu = directoryMenuRef.current;
      if (!menu || !(event.target instanceof Node)) return;
      if (!menu.contains(event.target)) setDirectoryMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDirectoryMenuOpen(false);
      directoryMenuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [directoryMenuOpen, useWebDirectoryPopover]);
  /**
   * The people picked for a bulk request, held whole rather than by id.
   *
   * This was a Set of ids read back against the rendered page, which meant a
   * selection only existed while its own page was on screen: picking four on
   * page one and two on page two sent two requests, and the counter said 2/8.
   * Paging is not deselecting, so the row is kept, not just its id.
   */
  const [selectedPeople, setSelectedPeople] = useState<
    Map<string, DirectoryPerson>
  >(new Map());
  const [isConnectingMultiple, setIsConnectingMultiple] = useState(false);
  /** Which open of the review sheet is allowed to write its catalogs back. */
  const batchDraftGenerationRef = useRef(0);
  const [batchConnectDraft, setBatchConnectDraft] = useState<{
    people: DirectoryPerson[];
    /** Per person: what THEY can be asked for. Absent until loaded. */
    catalogs: Record<string, ConnectionScopeCatalog>;
    /** Per person, because a handle is only valid for its own owner. */
    requestedHandles: Record<string, string[]>;
    /** Not per person: these are the caller's own, identical to everyone. */
    offeredHandles: string[];
    loadingCatalogs: boolean;
  } | null>(null);
  const [showLimitBanner, setShowLimitBanner] = useState(false);

  const getIdToken = useCallback(
    async () => (user ? await user.getIdToken() : null),
    [user],
  );

  const connectionAudience: ConnectionAudience =
    tab === "advisors" ? "ria" : "all";

  const loadConnectionsPage = useCallback(
    async (
      page: number,
      audience: ConnectionAudience,
      query = "",
    ): Promise<ConnectionPage | null> => {
      if (!user) return null;
      try {
        const idToken = await user.getIdToken();
        return await ConnectionsService.listConnectionsPage({
          idToken,
          page,
          limit: CONNECTION_PAGE_SIZE,
          query,
          audience,
        });
      } catch {
        // Non-fatal: the directory below remains available.
        return null;
      }
    },
    [user],
  );

  const loadOutgoingRequestIds = useCallback(async () => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      const requests = await ConnectionsService.listRequests({
        idToken,
        direction: "outgoing",
      });
      setOutgoingRequestIds(
        Object.fromEntries(
          requests.map((request) => [request.counterpartUserId, request.id]),
        ),
      );
    } catch {
      // Keep discovery available when the auxiliary request list is unavailable.
    }
  }, [user]);

  const refreshConnectionsFirstPage = useCallback(
    async ({
      audience,
      clearBeforeLoad = false,
      removedConnection = false,
    }: {
      audience: ConnectionAudience;
      clearBeforeLoad?: boolean;
      removedConnection?: boolean;
    }) => {
      const requestId = ++connectionsRequestRef.current;
      connectionsFirstPageRequestRef.current = requestId;
      // A first-page refresh supersedes every append in flight. Clear its
      // affordance synchronously so a page-2 response cannot leave the screen
      // saying "Loading…" while this new generation owns the list.
      setConnectionsLoadingMore(false);
      setConnectionsRefreshingFirstPage(true);
      if (clearBeforeLoad) {
        setConnections([]);
        setConnectionsTotalCount(0);
        setConnectionsPage(1);
        setConnectionsHasMore(false);
      }

      try {
        const result = await loadConnectionsPage(1, audience);
        if (requestId !== connectionsRequestRef.current) return false;

        if (result) {
          setConnections(result.items);
          setConnectionsPage(result.page);
          setConnectionsHasMore(result.hasMore);
          setConnectionsTotalCount(result.totalCount);
        } else if (removedConnection) {
          // Do not keep a page-2 cursor over a shifted server list: the next
          // offset would skip the row that moved across the boundary. This
          // fallback is generation-guarded above, so a superseded removal read
          // cannot erase a newer audience or mutation refresh.
          setConnections([]);
          setConnectionsPage(0);
          setConnectionsHasMore(true);
          setConnectionsTotalCount((current) => Math.max(0, current - 1));
        }
        return true;
      } finally {
        if (connectionsFirstPageRequestRef.current === requestId) {
          connectionsFirstPageRequestRef.current = null;
          setConnectionsRefreshingFirstPage(false);
        }
      }
    },
    [loadConnectionsPage],
  );

  // The same contact sync the One Location agent offers, on the screen whose
  // whole job is finding people. It is one implementation, not a second one:
  // everything about reading an address book, hashing numbers and matching
  // them lives in the hook, and this surface supplies only what is its own --
  // which list to refresh afterwards, and which route the analytics belong to.
  //
  // `onInviteShareStarted` is deliberately not passed. On Location it records
  // the acquisition source for that journey, and first touch wins inside it,
  // so calling it from here would not merely file a wrong row -- it would
  // consume the slot and leave a later, genuine Location touch unrecorded.
  const connectionAudienceRef = useRef(connectionAudience);
  connectionAudienceRef.current = connectionAudience;

  const contactSync = useContactSync({
    routeId: "connect",
    // `user ? getIdToken : null`, not `getIdToken`. The option is nullable so
    // the hook can check sign-in SYNCHRONOUSLY, before it asks GIS for a token
    // -- a token fetch in front of that call spends the tap's transient
    // activation and Safari blocks the popup. `getIdToken` here is a
    // useCallback, so it is always truthy and resolves to null when signed
    // out; passing it raw made the guard dead code and let the Google consent
    // popup open for a signed-out visitor. This restores the predicate the
    // Location page used.
    getIdToken: user ? getIdToken : null,
    accountPhoneNumber: user?.phoneNumber,
    userId: user?.uid,
    // Awaited, and its boolean dropped: the hook only needs to know the
    // refresh finished before it announces the outcome, so the toast never
    // claims a connection the list behind it has not caught up to.
    //
    // The audience is read from a ref rather than captured. A sync is long
    // enough to switch tabs under, and the hook snapshots its options once at
    // the start; a captured value would refresh the People audience into the
    // RIAs group and repaint it with the wrong people.
    onConnectionGraphChanged: async () => {
      await refreshConnectionsFirstPage({
        audience: connectionAudienceRef.current,
      });
      setDirectoryRefreshNonce((nonce) => nonce + 1);
    },
  });

  useEffect(() => {
    // Audience is part of the server-side truth for this list. Clear the
    // previous audience before loading so a failed RIAs request cannot leave
    // ordinary People rows displayed under the RIAs heading (or vice versa).
    void refreshConnectionsFirstPage({
      audience: connectionAudience,
      clearBeforeLoad: true,
    });
    return () => {
      connectionsRequestRef.current += 1;
    };
  }, [connectionAudience, refreshConnectionsFirstPage]);

  useEffect(() => {
    void loadOutgoingRequestIds();
  }, [loadOutgoingRequestIds]);

  useEffect(() => {
    const handleStateChanged = (event: Event) => {
      const detail =
        (event as CustomEvent<{ action?: unknown; reconcile?: unknown }>)
          .detail || {};
      // Only re-fetch for real mutations (`action`) or explicit reconcile
      // requests, not bookkeeping echoes like "fcm_opened" that would
      // otherwise flash the list on every notification read.
      if (!detail.action && !detail.reconcile) return;
      void refreshConnectionsFirstPage({ audience: connectionAudience });
      void loadOutgoingRequestIds();
      // A Circle roster open behind this page shows the same relationships,
      // one row per member. Without this it kept a blue "Connect" on somebody
      // who had just asked to connect with the viewer -- and pressing it then
      // claimed a request was sent and offered a Cancel the API refuses.
      setCircleRefreshToken((token) => token + 1);
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleStateChanged);
    return () => {
      window.removeEventListener(
        CONSENT_STATE_CHANGED_EVENT,
        handleStateChanged,
      );
    };
  }, [connectionAudience, loadOutgoingRequestIds, refreshConnectionsFirstPage]);

  // The directory is every account on Hussh, so listing all of it unprompted
  // stops being useful as soon as sign-ups outgrow a screen or two: the person
  // you came to connect with is buried among strangers, and paging through them
  // is the tedious part. Unsearched, this surface therefore shows a short
  // suggested sample and nothing more — enough that someone who does not yet
  // know a name has somewhere to start, small enough that it is never the thing
  // you have to scroll past. Naming a name is what opens the full directory.
  const trimmedQuery = debouncedQuery.trim();
  const hasQuery = trimmedQuery.length > 0;

  // A new query, or a new page size, is a new result set: go back to page one
  // rather than asking for page 4 of something the reader has just redefined.
  //
  // Adjusted during render rather than in an effect. As an effect this reset
  // landed one render too late: the fetch below runs in the same commit and
  // would already have requested page 3 of the new query, then re-run and
  // request page 1 of it -- two round trips per keystroke for anyone who had
  // paged, with the discarded one free to resolve last and paint a page the
  // reader never asked for. React re-renders on a state change made during
  // render before running effects, so the stale page is never requested.
  //
  // The audience is part of the key: switching People <-> Advisors is a new
  // result set, and asking for page 3 of a list the reader has just swapped is
  // the same mistake as asking for page 3 of a query they just retyped.
  const directoryAudience = CONNECT_TAB_AUDIENCE[tab];
  const isAdvisorTab = tab === "advisors";
  const connectionsHeading = isAdvisorTab
    ? `My RIAs (${connectionsTotalCount})`
    : `My connections (${connectionsTotalCount})`;
  const handleRefreshConnections = useCallback(() => {
    if (connectionsRefreshingFirstPage) return;
    void refreshConnectionsFirstPage({ audience: connectionAudience });
  }, [
    connectionAudience,
    connectionsRefreshingFirstPage,
    refreshConnectionsFirstPage,
  ]);
  // Searching a name and finding nobody has one likely explanation the
  // directory cannot act on: that person has not joined yet. Offered on People
  // only -- People searches the whole of One, so "not here" really does mean
  // "not on One". A name missing from RIAs means their adviser profile is not
  // verified, and one missing from Around you means they are not nearby;
  // neither is fixed by an app link, and offering one there would send someone
  // to invite a person who is already a member.
  //
  // Resolved once, not inside the handler: an invite the build cannot produce
  // a working link for is not offered at all, rather than rendered as a button
  // that fails when tapped.
  const inviteToOneShare = useMemo(() => buildInviteToOneShare(), []);
  const canInviteToOne = tab === "people" && inviteToOneShare !== null;

  const isDirectoryRefreshing = loading && people.length > 0;

  // A share sheet is modal but not instant: on iOS it animates in, and the
  // promise does not settle until it is dismissed. Two taps in that window
  // asked the platform to present a second sheet over the first, which iOS
  // rejects outright -- the person got an error toast for tapping twice. The
  // guard is a ref rather than state because the sheet is its own feedback;
  // re-rendering a row to disable it would only make the list flicker under
  // the sheet that just covered it.
  const invitingRef = useRef(false);

  const handleInviteToOne = useCallback(async () => {
    if (!inviteToOneShare || invitingRef.current) return;
    invitingRef.current = true;
    try {
      const delivery = await shareLink(inviteToOneShare);
      // Only the clipboard fallback needs saying out loud. The native sheet and
      // Web Share both show the person their own send, so a toast on top of
      // that reports something they just watched happen.
      if (delivery === "copied") toast.success("Invite link copied.");
    } catch (error) {
      // Dismissing the sheet is a decision, not a failure.
      if (isShareCancellationError(error)) return;
      toast.error(
        error instanceof ShareUnavailableError
          ? // Nothing to retry: no sheet, no Web Share, and the clipboard was
            // refused. Saying "could not share" would invite a second tap that
            // cannot go anywhere either.
            "This browser cannot share links."
          : // The channel exists and something went wrong inside it, so the
            // copy stays neutral about which rung failed.
            "Could not share the invite.",
      );
    } finally {
      invitingRef.current = false;
    }
  }, [inviteToOneShare]);

  const resultSetKey = `${directoryAudience}:${pageSize}:${trimmedQuery}`;
  const [directoryRefreshNonce, setDirectoryRefreshNonce] = useState(0);
  const [renderedResultSetKey, setRenderedResultSetKey] =
    useState(resultSetKey);
  if (renderedResultSetKey !== resultSetKey) {
    setRenderedResultSetKey(resultSetKey);
    setCurrentPage(1);
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user) return;
      try {
        if (currentPage <= 1) setHasMore(false);
        setLoading(true);
        setError(null);
        const idToken = await user.getIdToken();
        const page = await ConnectionsService.searchDirectory({
          idToken,
          query: trimmedQuery,
          page: currentPage,
          limit: pageSize,
          audience: directoryAudience,
        });
        if (!cancelled) {
          setPeople((current) => {
            if (page.page <= 1) return page.items;
            const merged = new Map(
              current.map((person) => [person.userId, person]),
            );
            for (const person of page.items) {
              merged.set(person.userId, person);
            }
            return Array.from(merged.values());
          });
          setHasMore(page.hasMore);
          // Selections deliberately survive this. They used to be pruned to
          // whoever the new page happened to show, on the reasoning that a
          // count the reader cannot see is a promise the surface can't account
          // for -- but the promise was real and the pruning silently broke it:
          // four picked on page one became zero on arriving at page two, and
          // two more picked there read as "2 selected". The count is now backed by
          // the rows themselves, and the sheet lists every one of them by name
          // before anything is sent, so nothing is promised unseen.
        }
      } catch (loadError) {
        if (!cancelled)
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load people",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    user,
    trimmedQuery,
    currentPage,
    pageSize,
    directoryAudience,
    // A contact sync can connect people who are sitting in this list right
    // now. Their rows carry a `relationship` the server decided before the
    // sync ran, so without this the directory keeps offering "Connect" to
    // somebody it just connected you to, and the request that follows is
    // refused. Bumping the nonce re-asks the server for the same page.
    directoryRefreshNonce,
  ]);

  const selectSurface = useCallback(
    (next: ConnectSurface) => {
      if (next === surface) return;
      const params = new URLSearchParams(searchParams.toString());
      // The default is written out explicitly. The App Router refuses a
      // navigation whose only change is that the whole query string
      // disappears -- measured on UAT and recorded in
      // `lib/navigation/top-shell-breadcrumbs.ts` -- so `?tab=all` is what
      // makes "back to People" a control that actually moves.
      params.set(CONNECT_SURFACE_PARAM, next);
      // A Circle you had open is not where "Circles" should take you next.
      // These params outlived the surface switch, so leaving for People
      // and tapping Circles again dropped you back inside the same roster
      // rather than at the list with New circle and Join with code on it.
      params.delete("action");
      params.delete("circleId");
      params.delete("code");
      // Leaving the people list discards a selection armed against it. A
      // six-person batch still primed under a list nobody can see is worse
      // than losing the picks: the button that sends it is on the other tab.
      if (next !== "all") {
        setIsSelectionMode(false);
        setSelectedPeople(new Map());
        setShowLimitBanner(false);
        setPendingRemoveId(null);
      }
      router.push(`${ROUTES.CONNECT}?${params.toString()}`, { scroll: false });
    },
    [router, searchParams, surface],
  );

  const loadNextDirectoryBatch = useCallback(() => {
    if (surface === "circles" || tab === "nearby" || loading || !hasMore)
      return;
    setCurrentPage((page) => page + 1);
  }, [hasMore, loading, surface, tab]);

  useEffect(() => {
    const sentinel = loadMoreDirectoryRef.current;
    if (
      !sentinel ||
      surface === "circles" ||
      tab === "nearby" ||
      !hasMore ||
      loading ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const scrollRoot = document.querySelector<HTMLElement>(
      '[data-app-scroll-root="true"]',
    );
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadNextDirectoryBatch();
        }
      },
      { root: scrollRoot, rootMargin: "240px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadNextDirectoryBatch, loading, surface, tab]);

  const sendConnectionRequest = useCallback(
    async (
      person: DirectoryPerson,
      requestedScopeHandles: string[] = [],
      offeredScopeHandles: string[] = [],
    ): Promise<boolean> => {
      if (!user) return false;
      try {
        setBusyId(person.userId);
        const idToken = await user.getIdToken();
        const request = await ConnectionsService.sendRequest({
          idToken,
          addresseeUserId: person.userId,
          requestedScopeHandles,
          offeredScopeHandles,
        });
        setPeople((prev) =>
          prev.map((p) =>
            p.userId === person.userId
              ? { ...p, relationship: "pending_outgoing" }
              : p,
          ),
        );
        setOutgoingRequestIds((current) => ({
          ...current,
          [person.userId]: request.id,
        }));
        CacheSyncService.onConnectionCapabilityMutated(user.uid);
        // A Circle roster open behind this sheet is now stale: the row that
        // said "Connect" should say "Requested". Re-read rather than patch.
        setCircleRefreshToken((token) => token + 1);
        toast.success("Connection request sent");
        return true;
      } catch (sendError) {
        toast.error(
          sendError instanceof Error
            ? sendError.message
            : "Failed to send request",
        );
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [user],
  );

  const sendConnectRequest = useCallback(
    async (person: DirectoryPerson) => {
      await sendConnectionRequest(person);
    },
    [sendConnectionRequest],
  );

  /**
   * A match from the results sheet follows the same one-tap request path as a
   * directory row. Connect no longer opens an extra capability dialog here.
   */
  const requestConnectionFromContactMatch = useCallback(
    async (matchUserId: string) => {
      const match = contactSync.result?.matches.find(
        (candidate) => candidate.userId === matchUserId,
      );
      contactSync.setResultsOpen(false);
      await sendConnectRequest({
        userId: matchUserId,
        displayName: match?.displayName ?? null,
        photoUrl: null,
        email: null,
        relationship: "none",
      });
    },
    [contactSync, sendConnectRequest],
  );

  const handleConnect = useCallback(
    (person: DirectoryPerson) => {
      if (!user || isSelectionMode) return;
      const cta = relationshipCta(person.relationship);
      if (cta.action === "respond") {
        router.push(buildConsentCenterHref("pending"));
        return;
      }
      if (cta.action === "connect") void sendConnectRequest(person);
    },
    [isSelectionMode, router, sendConnectRequest, user],
  );

  const handleRemove = useCallback(
    async (connection: ConnectionSummaryEntry) => {
      if (!user) return;
      try {
        setBusyId(connection.connectionId);
        const idToken = await user.getIdToken();
        await ConnectionsService.removeConnection({
          idToken,
          connectionId: connection.connectionId,
        });
        await refreshConnectionsFirstPage({
          audience: connectionAudience,
          removedConnection: true,
        });
        CacheSyncService.onConnectionGraphMutated(user.uid);
        // Let the directory offer "Connect" again for this person.
        setPeople((prev) =>
          prev.map((p) =>
            p.userId === connection.userId ? { ...p, relationship: "none" } : p,
          ),
        );
        toast.success("Connection removed");
      } catch (removeError) {
        toast.error(
          removeError instanceof Error
            ? removeError.message
            : "Failed to remove connection",
        );
      } finally {
        setBusyId(null);
        setPendingRemoveId(null);
      }
    },
    [connectionAudience, refreshConnectionsFirstPage, user],
  );

  const handleLoadMoreConnections = useCallback(async () => {
    if (
      connectionsFirstPageRequestRef.current !== null ||
      connectionsLoadingMore ||
      !connectionsHasMore
    ) {
      return;
    }
    const requestId = ++connectionsRequestRef.current;
    setConnectionsLoadingMore(true);
    try {
      const result = await loadConnectionsPage(
        connectionsPage + 1,
        connectionAudience,
      );
      if (requestId !== connectionsRequestRef.current || !result) return;
      setConnections((current) => {
        const merged = new Map(
          current.map((connection) => [connection.connectionId, connection]),
        );
        for (const connection of result.items) {
          merged.set(connection.connectionId, connection);
        }
        return Array.from(merged.values());
      });
      setConnectionsPage(result.page);
      setConnectionsHasMore(result.hasMore);
      setConnectionsTotalCount(result.totalCount);
    } finally {
      if (requestId === connectionsRequestRef.current) {
        setConnectionsLoadingMore(false);
      }
    }
  }, [
    connectionAudience,
    connectionsHasMore,
    connectionsLoadingMore,
    connectionsPage,
    loadConnectionsPage,
  ]);

  // The per-connection "Scopes" viewer is deliberately absent. It opened a
  // read-only dialog of raw scope handles with every row disabled — no action,
  // no explanation, and mostly the internal handle string itself. Connect
  // currently carries a single real capability, so the list told people
  // nothing they could act on. Bring it back with the surface it describes.

  /**
   * The (person, capability) pairs a bulk request can ask for.
   *
   * Flattened here rather than in the sheet so the empty case is one check
   * instead of a nested search through every person's catalog.
   */
  const batchRequestableRows = useMemo(() => {
    if (!batchConnectDraft) return [];
    return batchConnectDraft.people.flatMap((person) => {
      const catalog = batchConnectDraft.catalogs[person.userId];
      if (!catalog) return [];
      return catalog.items.map((item) => ({
        userId: person.userId,
        title: person.displayName || person.email || person.userId,
        item,
      }));
    });
  }, [batchConnectDraft]);

  /**
   * What the caller can offer. Identical for every counterpart, because these
   * handles belong to the caller, so the sheet asks once rather than per person.
   */
  const batchOfferableItems = useMemo(() => {
    if (!batchConnectDraft) return [];
    const byHandle = new Map<string, ConnectionScopeCatalog["items"][number]>();
    for (const catalog of Object.values(batchConnectDraft.catalogs)) {
      for (const item of catalog.offerableItems) {
        if (!byHandle.has(item.handle)) byHandle.set(item.handle, item);
      }
    }
    return [...byHandle.values()];
  }, [batchConnectDraft]);

  /**
   * Open the review sheet for a bulk request, and load what each person can be
   * asked for.
   *
   * The catalog is per counterpart, and its handles are per owner: the same
   * capability has a different handle for every person. A bulk send that reused
   * one person's handle for another would not fail -- the server drops an
   * unrecognised handle and returns success -- so the reader would be told
   * eight advisors had been asked for Picks when only one had been.
   */
  const openBatchConnectDraft = useCallback(
    async (people: DirectoryPerson[]) => {
      if (!user || people.length === 0) return;
      // Close the sheet, change the selection, reopen: the first load is still
      // in flight and would land on the second draft, clearing its loading flag
      // before its own catalogs arrive. That un-holds Send with no handles
      // collected -- a send reported as a success that asked for nothing, which
      // is the failure this whole sheet exists to end. Only the newest open
      // gets to write.
      const generation = batchDraftGenerationRef.current + 1;
      batchDraftGenerationRef.current = generation;
      const isCurrent = () => batchDraftGenerationRef.current === generation;
      setBatchConnectDraft({
        people,
        catalogs: {},
        requestedHandles: {},
        offeredHandles: [],
        loadingCatalogs: true,
      });
      try {
        const idToken = await user.getIdToken();
        const loaded = await mapWithConcurrency(
          people,
          CONNECT_REQUEST_CONCURRENCY,
          async (person) => {
            try {
              return await ConnectionsService.getScopeCatalog({
                idToken,
                counterpartUserId: person.userId,
              });
            } catch {
              // One person's catalog being unavailable is not a reason to
              // refuse the other seven. They are shown with nothing to ask
              // for, which is what a scopeless request already means.
              return null;
            }
          },
        );
        const catalogs: Record<string, ConnectionScopeCatalog> = {};
        loaded.forEach((catalog, index) => {
          const person = people[index];
          if (catalog && person) catalogs[person.userId] = catalog;
        });
        if (!isCurrent()) return;
        setBatchConnectDraft((current) =>
          current === null
            ? current
            : { ...current, catalogs, loadingCatalogs: false },
        );
      } catch {
        if (!isCurrent()) return;
        setBatchConnectDraft((current) =>
          current === null ? current : { ...current, loadingCatalogs: false },
        );
      }
    },
    [user],
  );

  const toggleBatchRequestedHandle = useCallback(
    (userId: string, handle: string, checked: boolean) => {
      setBatchConnectDraft((current) => {
        if (!current) return current;
        const existing = current.requestedHandles[userId] ?? [];
        const next = checked
          ? [...new Set([...existing, handle])]
          : existing.filter((candidate) => candidate !== handle);
        return {
          ...current,
          requestedHandles: { ...current.requestedHandles, [userId]: next },
        };
      });
    },
    [],
  );

  const toggleBatchOfferedHandle = useCallback(
    (handle: string, checked: boolean) => {
      setBatchConnectDraft((current) => {
        if (!current) return current;
        const next = checked
          ? [...new Set([...current.offeredHandles, handle])]
          : current.offeredHandles.filter((candidate) => candidate !== handle);
        return { ...current, offeredHandles: next };
      });
    },
    [],
  );

  const handleConnectMultiple = useCallback(async () => {
    if (!user || !batchConnectDraft || batchConnectDraft.people.length === 0)
      return;
    const draft = batchConnectDraft;
    const draftPeople = draft.people;

    // Keep the dispatch boundary bounded even if selection state is restored or
    // changed outside the row controls.
    if (draftPeople.length > MAX_BULK_CONNECTION_REQUESTS) {
      toast.error(
        `Select no more than ${MAX_BULK_CONNECTION_REQUESTS} people at a time.`,
      );
      return;
    }

    setIsConnectingMultiple(true);
    const successfulUserIds = new Set<string>();

    try {
      const idToken = await user.getIdToken();

      // Anyone already asked is skipped: a pending request in either direction
      // makes the server return the existing one and discard the scopes, so
      // including them would report a send that attached nothing.
      const sendable = draftPeople.filter(
        (person) => person.relationship === "none",
      );

      const results = await mapWithConcurrency(
        sendable,
        CONNECT_REQUEST_CONCURRENCY,
        async (person) => {
          try {
            const request = await ConnectionsService.sendRequest({
              idToken,
              addresseeUserId: person.userId,
              // This person's own handles, never another's.
              requestedScopeHandles:
                draft.requestedHandles[person.userId] ?? [],
              offeredScopeHandles: draft.offeredHandles,
            });
            return { success: true, person, request } as const;
          } catch (sendError) {
            console.error(
              `Failed to send request to ${person.userId}`,
              sendError,
            );
            return { success: false, person } as const;
          }
        },
      );

      const outgoing: Record<string, string> = {};
      for (const result of results) {
        if (result.success) {
          outgoing[result.person.userId] = result.request.id;
          successfulUserIds.add(result.person.userId);
        }
      }
      if (successfulUserIds.size > 0) {
        setOutgoingRequestIds((current) => ({ ...current, ...outgoing }));
      }

      setPeople((prev) =>
        prev.map((p) =>
          successfulUserIds.has(p.userId) && p.relationship === "none"
            ? { ...p, relationship: "pending_outgoing" }
            : p,
        ),
      );

      const failedCount = sendable.length - successfulUserIds.size;
      if (successfulUserIds.size > 0) {
        CacheSyncService.onConnectionCapabilityMutated(user.uid);
        // Report what happened rather than only what worked. A partial send
        // that says "Sent 6 requests" leaves two people quietly unasked.
        toast.success(
          failedCount > 0
            ? `Sent ${successfulUserIds.size}. ${failedCount} couldn't be sent.`
            : `Sent ${successfulUserIds.size} request${successfulUserIds.size !== 1 ? "s" : ""}.`,
        );
      } else if (sendable.length === 0) {
        toast.error("Already asked.");
      } else {
        toast.error("Couldn't send. Try again.");
      }

      // Only the people who were actually sent leave the selection. Anyone who
      // failed stays picked, so retrying does not mean finding them again --
      // which, now that picks survive paging, could otherwise mean paging back
      // through the directory to rebuild a selection that already existed.
      setSelectedPeople((current) => {
        if (successfulUserIds.size === 0 && sendable.length > 0) return current;
        const next = new Map(current);
        // Nobody sendable means nothing here is still actionable, so the whole
        // selection goes rather than leaving rows checked that cannot be sent.
        if (sendable.length === 0) return new Map();
        successfulUserIds.forEach((userId) => next.delete(userId));
        return next;
      });
      if (successfulUserIds.size === sendable.length) {
        setIsSelectionMode(false);
        setBatchConnectDraft(null);
      } else {
        setBatchConnectDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                people: current.people.filter(
                  (person) => !successfulUserIds.has(person.userId),
                ),
              },
        );
      }
    } catch {
      toast.error("Couldn't send. Try again.");
    } finally {
      setIsConnectingMultiple(false);
    }
  }, [user, batchConnectDraft]);

  const cancelConnectionRequest = useCallback(
    async (person: DirectoryPerson) => {
      if (!user) return;
      const requestId = outgoingRequestIds[person.userId] || person.userId;
      try {
        setBusyId(person.userId);
        const idToken = await user.getIdToken();
        await ConnectionsService.cancel({ idToken, requestId });
        setPeople((current) =>
          current.map((candidate) =>
            candidate.userId === person.userId
              ? { ...candidate, relationship: "none" }
              : candidate,
          ),
        );
        setOutgoingRequestIds((current) => {
          const { [person.userId]: _cancelled, ...remaining } = current;
          return remaining;
        });
        CacheSyncService.onConnectionCapabilityMutated(user.uid);
        setCircleRefreshToken((token) => token + 1);
        toast.success("Connection request cancelled");
      } catch (cancelError) {
        toast.error(
          cancelError instanceof Error
            ? cancelError.message
            : "Failed to cancel connection request",
        );
      } finally {
        setBusyId(null);
      }
    },
    [outgoingRequestIds, user],
  );

  // Present connections in a stable, predictable order: alphabetical by the
  // name the user sees (case-insensitive), falling back to the userId when a
  // display name is absent. Locale compare keeps accented names sensibly placed.
  // The server owns matching, ranking and order; this renders the page it
  // returned, unchanged.
  //
  // It used to re-filter here -- keep only rows whose name starts with the
  // query -- on top of a server that matched any substring. Filtering AFTER
  // the server has already applied LIMIT/OFFSET can only subtract from a page
  // that was chosen by the wrong rule, and it did: typing "n" asked for 8
  // rows, got the 8 alphabetically-first names merely CONTAINING an n (Anand,
  // Ankit, Arun...), and hid every one of them. The list rendered empty while
  // Nilesh and Nirmal sat pages deeper in a result set the reader could not
  // walk to, and "Next" stayed lit because `hasMore` described the rows the
  // server sent rather than the rows that survived. No amount of client
  // cleverness fixes that; the query itself had to select the right page.
  //
  // Both tiers the filter used to approximate now live in the SQL, so "n"
  // returns every N person A-Z and "rashid" still finds "Abdul Rashid",
  // ranked below the first-name matches rather than mixed in with them.
  //
  // Re-sorting here would reintroduce the same class of bug in a quieter
  // form: a client sort can only order the current page, so a name on page 2
  // could sort ahead of one on page 1 and the A-Z index would be a lie at
  // every boundary. One ordering, applied where the paging happens.
  //
  // `people` is therefore rendered directly, and there is deliberately no
  // second derived list. The original bug needed two: the empty state counted
  // one and the rows came from the other, so "8 rows, all hidden" was
  // indistinguishable from "8 rows" to every guard on the screen. With one
  // list there is nothing left to disagree.

  // ONE list, for the same reason the search results above are one list: the
  // heading's count, the empty state, and the rows must all be counting the
  // same thing. The RIAs tab used to render this list unfiltered, so it
  // repeated the People tab exactly -- someone who had not finished RIA
  // onboarding was listed under "RIAs", which is the one claim this tab makes.
  //
  // Filter before sort, and read `isRia` rather than the tab: a row says what
  // it is, so a connection the server has not annotated is simply not an
  // advisor, instead of becoming one by sitting under the advisor tab.
  const sortedConnections = connections;

  // Voice surface for Connect. Until this existed the route derived the
  // generic "app" screen, so One knew a person was somewhere in the app and
  // nothing more -- and Connect could not be named as a destination, which is
  // why an empty people list elsewhere had nowhere to send anyone.
  const connectVoiceSurfaceMetadata = useMemo(() => {
    const circleTaskTitle = connectCircleTaskTitle(circleFlowAction);
    if (isFocusedCircleTask && circleTaskTitle) {
      return {
        screenId: "connect.circle_task",
        title: circleTaskTitle,
        purpose:
          circleFlowAction === "create-circle"
            ? "This screen names a Circle and chooses its type."
            : "This screen reviews a Circle invite code before joining.",
        primaryEntity: null,
        selectedEntity: null,
        spokenSubject: circleTaskTitle,
        sections: [
          {
            id: "circle_task",
            title: circleTaskTitle,
            purpose:
              circleFlowAction === "create-circle"
                ? "Create one Circle, then add people after it exists."
                : "Enter a 12-character invite code and review the Circle before joining.",
          },
        ],
        actions: [
          {
            id:
              circleFlowAction === "create-circle"
                ? "connect.circle_create"
                : "connect.circle_review",
            actionId:
              circleFlowAction === "create-circle"
                ? "connect.circle_create"
                : "connect.circle_review",
            label:
              circleFlowAction === "create-circle"
                ? "Create Circle"
                : "Review Circle",
            purpose:
              circleFlowAction === "create-circle"
                ? "Create the named Circle."
                : "Review the invite code.",
          },
        ],
        controls: [],
        concepts: [],
        activeSection: circleTaskTitle,
        activeTab: "circles",
        visibleModules: [circleTaskTitle],
        focusedWidget: circleTaskTitle,
        availableActions: [
          circleFlowAction === "create-circle"
            ? "Create Circle"
            : "Review Circle",
        ],
        activeControlId: null,
        lastInteractedControlId: null,
        busyOperations: loading ? ["connect_circle_task_load"] : [],
        screenMetadata: {
          connect_surface: surface,
          circle_action: circleFlowAction,
          searching: false,
        },
      };
    }

    return {
      screenId: "connect",
      title: "Connect",
      purpose:
        "This screen finds people, sends connection requests, and manages who you are connected to.",
      // The subjects here are people, by name and email. None of that is safe
      // to say aloud, so this screen names only itself.
      primaryEntity: null,
      selectedEntity: null,
      spokenSubject:
        surface === "circles"
          ? "Connect, Circles tab"
          : `Connect, ${CONNECT_TAB_LABEL[tab]} tab`,
      sections: [
        {
          id: "circles",
          title: "Circles",
          purpose:
            "See the groups you are in -- Trusted holds everyone you are connected to, the SMS Circle gets your SMS -- and open one to manage who is in it.",
        },
        {
          id: "people",
          title: "People",
          purpose:
            "Search everyone you could connect with, and manage existing connections.",
        },
        {
          id: "advisors",
          title: "Advisors",
          purpose:
            "Search only people whose registered investment adviser profile is verified.",
        },
        {
          id: "nearby",
          title: "Around you",
          purpose:
            "Find verified advisors and insurance agents, and businesses, near your current location.",
        },
      ],
      actions: [
        {
          id: "connect.open_people",
          actionId: "connect.open_people",
          label: "Open Connect people",
          purpose: "Show connections and the people directory.",
        },
        {
          id: "connect.open_nearby",
          actionId: "connect.open_nearby",
          label: "Open advisors around you",
          purpose: "Show advisors near you.",
        },
        {
          id: "connect.search_people",
          actionId: "connect.search_people",
          label: "Search for someone to connect with",
          purpose: "Search the directory for the spoken name.",
        },
        {
          id: "connect.send_request",
          actionId: "connect.send_request",
          label: "Send a connection request",
          purpose:
            "Send a request to one exact name after the person confirms by voice.",
        },
      ],
      // Only the search box carries a `data-voice-control-id` anchor. The tab
      // strip is the shared TopShellTabs, which has no per-option control id,
      // so claiming one here would describe a hook that does not exist.
      controls: [
        {
          id: "one-connect-search",
          label: "Search people",
          purpose: "Search the directory by name.",
          actionId: "connect.search_people",
          role: "textbox",
        },
      ],
      concepts: [
        {
          id: "connection",
          label: "Connection",
          explanation:
            "A connection is a person who has accepted your request. Connections are who you can share things with, including your location.",
          aliases: ["connection", "connections", "connected people"],
        },
      ],
      activeSection: surface === "circles" ? "Circles" : CONNECT_TAB_LABEL[tab],
      activeTab: surface === "circles" ? "circles" : tab,
      visibleModules:
        tab === "nearby"
          ? [
              "Advisors near you",
              "Insurance agents near you",
              "Places near you",
            ]
          : tab === "advisors"
            ? ["Your connections", "Verified advisers directory"]
            : ["Your connections", "People directory"],
      focusedWidget:
        surface === "circles" ? "Circles tab" : `${CONNECT_TAB_LABEL[tab]} tab`,
      availableActions: [
        "Open Connect people",
        "Open advisors around you",
        "Search for someone to connect with",
        "Open your circles",
      ],
      activeControlId: null,
      lastInteractedControlId: null,
      busyOperations: loading ? ["connect_directory_load"] : [],
      // Counts only -- never who.
      screenMetadata: {
        connect_tab: tab,
        // The outer axis, reported separately: `connect_tab` has always
        // meant which directory, and reusing it for a different question
        // would silently change what every existing reading of it meant.
        connect_surface: surface,
        circle_count: circlesState.count,
        connection_count: connectionsTotalCount,
        has_load_error: Boolean(error),
        searching: query.trim().length > 0,
      },
    };
  },
    [
      circleFlowAction,
      circlesState.count,
      connectionsTotalCount,
      error,
      isFocusedCircleTask,
      loading,
      query,
      surface,
      tab,
    ],
  );
  usePublishVoiceSurfaceMetadata(connectVoiceSurfaceMetadata);

  // Each of these brings the directory surface forward before touching the hub
  // tab. `setTab` alone moves a control that is not active while Circles is
  // showing, so "open people" reported success and did nothing --
  // and a voice action that lies about what happened is worse than one that
  // refuses, because the person stops watching for the result.
  useLocalOnboardingActionHandler("connect.open_people", () => {
    selectSurface("all");
    setTab("people");
    return { status: "succeeded", summary: "Connect people opened." };
  });
  useLocalOnboardingActionHandler("connect.open_nearby", () => {
    selectSurface("all");
    setTab("nearby");
    return { status: "succeeded", summary: "Advisors around you opened." };
  });
  useLocalOnboardingActionHandler("connect.search_people", (slots) => {
    // The model provides only the words it heard. This mounted surface resolves
    // those words against the directory it already holds; no account id or
    // contact information crosses the voice boundary.
    const person = typeof slots.person === "string" ? slots.person.trim() : "";
    if (!person) {
      return {
        status: "blocked",
        summary: "Say the name to search for in Connect.",
      };
    }
    selectSurface("all");
    setTab("people");
    setQuery(person);
    searchInputRef.current?.focus();
    return {
      status: "succeeded",
      summary: "Searching Connect for the name you gave.",
    };
  });
  useLocalOnboardingActionHandler("connect.send_request", async (slots) => {
    const spokenName =
      typeof slots.person === "string" ? slots.person.trim() : "";
    // Set only by the disambiguation card, which resolves a name the person
    // already saw into the one account they pointed at. It skips the matcher
    // entirely rather than re-running it: the ambiguity has been settled by a
    // human, and re-deriving it from the same words would just fail the same
    // way and bounce the card straight back.
    const chosenUserId =
      typeof slots.userId === "string" ? slots.userId.trim() : "";
    if (!user) {
      return {
        status: "blocked",
        summary: "Sign in before sending a connection request.",
      };
    }
    if (!spokenName && !chosenUserId) {
      return {
        status: "blocked",
        summary: "Say the person's full name before sending a request.",
      };
    }

    try {
      const idToken = await user.getIdToken();
      // Read the whole result set for this name, not its first three rows.
      //
      // This searched page 1 at limit 3 and refused outright whenever
      // `hasMore` was true, so it could never tell "no such person" from "not
      // on the first page" -- and it answered both with "I could not identify
      // one exact person by that name", about people who were plainly there.
      // Bounded, because a directory is unbounded and a runaway loop here
      // would be worse than a refusal.
      // Search on ONE word, then match the full name here.
      //
      // The server predicate is a single substring test --
      // `LOWER(display_name) LIKE '%' || query || '%'` -- so passing the whole
      // spoken name makes the whole name have to appear, contiguously, exactly
      // as stored. "Abdul Rashid" then finds nobody when the directory holds
      // "Abdul R.", and "Abdul" finds nobody when it holds "Abdul Kumar
      // Rashid". Reported as voice being unable to find people plainly visible
      // in the list, which is exactly what it was: the query could not reach
      // them, so there was never a candidate for the matcher to consider.
      //
      // One token maximises what comes back; deciding WHICH person stays here,
      // where the whole name is available. Longest word rather than first,
      // because it is the most selective and least likely to be a title or
      // initial.
      const searchTerm =
        spokenName
          .split(/\s+/)
          .filter(Boolean)
          .sort((left, right) => right.length - left.length)[0] ?? spokenName;
      const candidates: DirectoryPerson[] = [];
      for (
        let pageNumber = 1;
        pageNumber <= DIRECTORY_RESOLVE_MAX_PAGES;
        pageNumber += 1
      ) {
        const page = await ConnectionsService.searchDirectory({
          idToken,
          query: searchTerm,
          page: pageNumber,
          limit: DIRECTORY_RESOLVE_PAGE_SIZE,
        });
        candidates.push(...page.items);
        if (!page.hasMore) break;
      }
      // Same matcher the cancel and remove actions use: exact wins outright,
      // and only when nothing is exact does a prefix or whole-word match
      // count, so "Sarah" finds "Sarah Chen" without "Chen" matching every
      // Chen. Requiring full-name equality made the person say a name the way
      // the directory happens to store it, which is not something they can
      // know.
      // A resolved id wins outright: the person has already pointed at a row.
      const exactMatches = chosenUserId
        ? candidates.filter((c) => c.userId === chosenUserId)
        : matchByName(candidates, spokenName, (c) => c.displayName);
      if (exactMatches.length === 0) {
        return {
          status: "blocked",
          summary: chosenUserId
            ? "That person is no longer in the directory."
            : `I could not find anyone called ${spokenName} in Connect.`,
        };
      }
      if (exactMatches.length > 1) {
        // Show them instead of asking. Naming the candidates aloud was already
        // better than "be more specific", but it cannot resolve the ordinary
        // case where two accounts share a display name -- there is no utterance
        // that separates them, so the person is asked for something they cannot
        // give. What tells them apart is the handle under the name, so it has
        // to be seen.
        return {
          status: "blocked",
          summary: `${exactMatches.length} people are called ${spokenName}. Pick the right one.`,
          data: {
            [VOICE_DISAMBIGUATION_DATA_KEY]: {
              actionId: "connect.send_request",
              resolveSlot: "userId",
              slots: { person: spokenName },
              prompt: `${exactMatches.length} people are called ${spokenName}.`,
              candidates: exactMatches.map((c) => ({
                id: c.userId,
                name: c.displayName || "Someone",
                // The same description the Connect list renders under each
                // name. Reading `email` alone showed "No other details" on
                // rows the list behind the card was captioning correctly:
                // the directory usually returns the masked variants, not the
                // raw address. This helper already falls through
                // email -> maskedEmail -> maskedPhone, so contact sync's phone
                // numbers land here without another change.
                detail: getDirectoryPersonDescription(c) ?? null,
                ...connectCandidateAffordance(c.relationship),
              })),
            },
          },
        };
      }
      const person = exactMatches[0];
      if (!person) {
        return {
          status: "blocked",
          summary: "I could not identify one exact person by that name.",
        };
      }
      // The backend already distinguishes these four, and collapsing them lost
      // the only part the person needed. "A new connection request is not
      // available" was returned when they were ALREADY connected -- which is
      // success -- and equally when the other party had yet to accept, when
      // the person had an invitation of their own sitting unread, and when
      // something had genuinely gone wrong. Reported as One saying it needed
      // approval for something already done.
      //
      // Only `none` sends. The rest each mean something specific and are said
      // plainly, because two of them are not problems at all.
      if (person.relationship === "connected") {
        return {
          // `succeeded`, not `blocked`. The person asked to be connected to
          // someone they are already connected to: the thing they wanted is
          // true, so anything that sounds like a refusal is a lie about their
          // own account. (A local handler has no `noop`; the settlement enum
          // does, but this layer only speaks started/succeeded/blocked/failed.)
          status: "succeeded",
          summary: `You are already connected to ${person.displayName}, so there was nothing to send.`,
        };
      }
      if (person.relationship === "pending_outgoing") {
        return {
          status: "blocked",
          // The honest boundary: nothing the app or One can do advances this.
          summary: `You already asked ${person.displayName} to connect, and it is waiting on them to accept. Nobody here can move that along.`,
        };
      }
      if (person.relationship === "pending_incoming") {
        return {
          status: "blocked",
          summary: `${person.displayName} has already asked to connect with you. Open Connect and accept request instead of sending one back.`,
        };
      }
      if (person.relationship !== "none") {
        return {
          status: "blocked",
          summary: "A new connection request is not available for that person.",
        };
      }
      const sent = await sendConnectionRequest(person);
      if (!sent) {
        return {
          status: "failed",
          summary: "Could not send the connection request.",
        };
      }
      return {
        status: "succeeded",
        summary: `Connection request sent to ${person.displayName}.`,
        data: {
          subject: {
            name: person.displayName || "Someone",
            detail: getDirectoryPersonDescription(person) ?? null,
          },
        },
      };
    } catch (error) {
      return {
        status: "failed",
        summary:
          error instanceof Error
            ? error.message
            : "Could not send the connection request.",
      };
    }
  });

  useLocalOnboardingActionHandler("connect.cancel_request", async (slots) => {
    const spokenName =
      typeof slots.person === "string" ? slots.person.trim() : "";
    if (!user) {
      return {
        status: "blocked",
        summary: "Sign in before cancelling a request.",
      };
    }
    if (!spokenName) {
      return {
        status: "blocked",
        summary: "Say whose request you want to cancel.",
      };
    }
    try {
      const idToken = await user.getIdToken();
      // Ask the server for the outgoing requests rather than matching against
      // whatever the directory happens to be showing. `connect.send_request`
      // resolves through a page-1/limit-3 search, which cannot tell "no such
      // person" from "not on the first page"; cancelling the wrong request, or
      // refusing to cancel a real one, are both worse than a slower lookup.
      const outgoing = await ConnectionsService.listRequests({
        idToken,
        direction: "outgoing",
      });
      const matches = matchByName(
        outgoing,
        spokenName,
        (request) => request.counterpartDisplayName,
      );
      if (matches.length === 0) {
        return {
          status: "blocked",
          summary: `You have no pending request to ${spokenName}.`,
        };
      }
      if (matches.length > 1) {
        return {
          status: "blocked",
          summary: `More than one pending request matches that name: ${matches
            .map((request) => request.counterpartDisplayName ?? "someone")
            .join(", ")}. Say which one.`,
        };
      }
      const request = matches[0]!;
      await ConnectionsService.cancel({ idToken, requestId: request.id });
      CacheSyncService.onConnectionCapabilityMutated(user.uid);
      await loadOutgoingRequestIds();
      return {
        status: "succeeded",
        summary: `Cancelled your connection request to ${request.counterpartDisplayName ?? spokenName}.`,
      };
    } catch (error) {
      return {
        status: "failed",
        summary:
          error instanceof Error
            ? error.message
            : "Could not cancel that request.",
      };
    }
  });

  useLocalOnboardingActionHandler(
    "connect.remove_connection",
    async (slots) => {
      const spokenName =
        typeof slots.person === "string" ? slots.person.trim() : "";
      // Set by the card's destructive button and by nothing else. Voice never
      // carries it, so a spoken sentence can raise this question but can never
      // answer its own question.
      const confirmed = slots.confirmed === true;
      const chosenConnectionId =
        typeof slots.connectionId === "string" ? slots.connectionId.trim() : "";
      if (!user) {
        return {
          status: "blocked",
          summary: "Sign in before removing a connection.",
        };
      }
      if (!spokenName && !chosenConnectionId) {
        return { status: "blocked", summary: "Say who you want to remove." };
      }
      try {
        const idToken = await user.getIdToken();
        const resolved = await resolveConnectionForVoice({
          idToken,
          spokenName,
          connectionId: chosenConnectionId,
        });
        if (!resolved.complete) {
          return {
            status: "blocked",
            summary:
              "Too many connections match that name to remove one safely. Open Connect and choose the person.",
          };
        }
        const matches = resolved.matches;
        if (matches.length === 0) {
          return {
            status: "blocked",
            summary: chosenConnectionId
              ? "That connection is no longer there."
              : `${spokenName} is not one of your connections.`,
          };
        }
        if (matches.length > 1) {
          // Same picker as sending a request. Removing the wrong person because
          // two share a name is the worst version of this bug, not a milder one.
          return {
            status: "blocked",
            summary: `${matches.length} connections are called ${spokenName}. Pick the right one.`,
            data: {
              [VOICE_DISAMBIGUATION_DATA_KEY]: {
                actionId: "connect.remove_connection",
                resolveSlot: "connectionId",
                slots: { person: spokenName },
                prompt: `${matches.length} connections are called ${spokenName}.`,
                candidates: matches.map((entry) => ({
                  id: entry.connectionId,
                  name: entry.displayName || "Someone",
                  detail: getDirectoryPersonDescription(entry) ?? null,
                  actionLabel: "Remove",
                })),
              },
            },
          };
        }
        const connection = matches[0]!;
        if (!confirmed) {
          // Ask before, not after. A name misheard once is a connection gone
          // with no undo, and this is the one action here where being wrong
          // cannot be walked back.
          const displayName = connection.displayName || "this person";
          return {
            status: "blocked",
            summary: `Removing ${displayName} needs a confirmation.`,
            data: {
              [VOICE_CONFIRM_DATA_KEY]: {
                actionId: "connect.remove_connection",
                slots: {
                  person: spokenName,
                  connectionId: connection.connectionId,
                },
                prompt: `Remove your connection with ${displayName}?`,
                subject: {
                  name: displayName,
                  detail: getDirectoryPersonDescription(connection) ?? null,
                },
                // The action's own words from the generated contract, so what
                // the person is warned about cannot drift from what happens.
                consequence:
                  getKaiActionById("connect.remove_connection")?.meaning ??
                  null,
                confirmLabel: "Remove",
              },
            },
          };
        }
        await ConnectionsService.removeConnection({
          idToken,
          connectionId: connection.connectionId,
        });
        await refreshConnectionsFirstPage({
          audience: connectionAudience,
          removedConnection: true,
        });
        CacheSyncService.onConnectionGraphMutated(user.uid);
        return {
          status: "succeeded",
          // Say the consequence, not just the fact. Removing a connection also
          // removes them from everywhere that connection was the prerequisite --
          // Location sharing above all -- and someone who only meant to tidy a
          // list should hear that before they discover it.
          summary: `Removed ${connection.displayName ?? spokenName}. They can no longer be picked for location sharing.`,
        };
      } catch (error) {
        return {
          status: "failed",
          summary:
            error instanceof Error
              ? error.message
              : "Could not remove that connection.",
        };
      }
    },
  );

  const directoryMenuItems = CONNECT_DIRECTORY_TABS.map((option) => {
    const active = tab === option.value;
    return (
      <button
        key={option.value}
        type="button"
        role="menuitemradio"
        aria-checked={active}
        className={cn(
          "flex min-h-11 w-full items-center justify-between px-3 text-left text-[15px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
          useWebDirectoryPopover ? "rounded-[12px]" : "rounded-[10px]",
          active
            ? "text-[color:var(--app-accent)]"
            : "text-[color:var(--app-primary-label)] hover:bg-[color:var(--app-secondary-fill)]",
        )}
        onClick={() => {
          setTab(option.value);
          setDirectoryMenuOpen(false);
          window.requestAnimationFrame(() =>
            directoryMenuButtonRef.current?.focus(),
          );
        }}
      >
        <span>{option.label}</span>
        {active ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
      </button>
    );
  });

  return (
    <AppPageShell
      as="main"
      fitContent
      width="agent"
      className="relative isolate"
      nativeTest={{
        routeId: "/one/connect",
        marker: "native-route-connect",
        authState: user ? "authenticated" : "pending",
        dataState:
          surface === "circles"
            ? circlesState.error
              ? "unavailable-valid"
              : circlesState.loading
                ? "loading"
                : circlesState.count === 0
                  ? "empty-valid"
                  : "loaded"
            : error
              ? "unavailable-valid"
              : loading
                ? "loading"
                : people.length === 0
                  ? "empty-valid"
                  : "loaded",
        errorCode:
          surface === "circles"
            ? circlesState.error
              ? "connect_circles_unavailable"
              : null
            : error
              ? "connect_directory_unavailable"
              : null,
        errorMessage: surface === "circles" ? circlesState.error : error,
      }}
    >
      {isFocusedCircleTask ? (
        <AppPageContentRegion className={CONNECT_PAGE_CONTENT_CLASSNAME}>
          <div className="mx-auto w-full max-w-[560px]">            <ConnectCirclesTab
              onStateChange={setCirclesState}
              currentUserId={user?.uid ?? null}
              onRequestConnection={sendConnectRequest}
              onCancelConnectionRequest={cancelConnectionRequest}
              refreshToken={circleRefreshToken}
            />
          </div>
        </AppPageContentRegion>
      ) : (
        <>
          <AppPageHeaderRegion>
            <PageHeader
              title="Connect"
              titleRole="agent"
              className="[&_[data-slot=page-header-row]]:!items-center"
            />
          </AppPageHeaderRegion>

          <AppPageContentRegion className={CONNECT_PAGE_CONTENT_CLASSNAME}>
            <SurfaceStack compact>          <div
            ref={connectStackRef}
            className="relative space-y-4 sm:space-y-5"
          >
            {/* Where the header sits when it is NOT pinned, held open as a 1px
                line so an observer can watch that spot leave the scrollport.
                Absolutely positioned, so it is out of flow: `space-y-*` gives a
                first child `margin-block-end` only, which an absolute box with
                `top: 0` cannot act on, and the strips below keep their rhythm.
                Reading the header itself would prove nothing -- once pinned it
                never leaves, which is the whole point of it. */}
            <div
              ref={stickyPinSentinelRef}
              data-testid="connect-sticky-pin-sentinel"
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px"
            />
            <div
              ref={stickyHeaderRef}
              data-testid="connect-sticky-header"
              // Written by the observer above. Declared here so the attribute
              // exists from the first paint rather than arriving a frame later,
              // which is a frame of the cover in the wrong state.
              data-pinned="false"
              className={CONNECT_STICKY_HEADER_CLASSNAME}
            >
              <TopShellTabs
                tabSet={{
                  ...CONNECT_SURFACE_TAB_DEFINITION,
                  activeValue: surface,
                }}
                navigationMode="push"
              />
              {surface !== "circles" ? (
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div
                      ref={directoryMenuRef}
                      data-testid="connect-directory-menu-anchor"
                      className="relative"
                    >
                      {useWebDirectoryPopover ? (
                        <Popover
                          open={directoryMenuOpen}
                          onOpenChange={setDirectoryMenuOpen}                        >
                          <PopoverTrigger asChild>
                            <button
                              ref={directoryMenuButtonRef}
                              type="button"
                              aria-haspopup="menu"
                              aria-expanded={directoryMenuOpen}
                              aria-label={`Current directory: ${CONNECT_TAB_LABEL[tab]}`}
                              className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-1 text-[17px] font-semibold leading-[22px] text-[color:var(--app-primary-label)] transition-colors hover:text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
                            >
                              {CONNECT_TAB_LABEL[tab]}
                              <ChevronDown
                                className="h-4 w-4 text-[color:var(--app-secondary-label)]"
                                aria-hidden
                              />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            role="menu"
                            data-testid="connect-directory-menu"
                            align="start"
                            side="bottom"
                            sideOffset={6}
                            collisionPadding={16}
                            className={CONNECT_WEB_DIRECTORY_POPOVER_CLASSNAME}
                          >
                            {directoryMenuItems}
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <>
                          <button
                            ref={directoryMenuButtonRef}
                            type="button"
                            aria-haspopup="menu"
                            aria-expanded={directoryMenuOpen}
                            aria-label={`Current directory: ${CONNECT_TAB_LABEL[tab]}`}
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-1 text-[17px] font-semibold leading-[22px] text-[color:var(--app-primary-label)] transition-colors hover:text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
                            onClick={() =>
                              setDirectoryMenuOpen((current) => !current)
                            }
                          >
                            {CONNECT_TAB_LABEL[tab]}
                            <ChevronDown
                              className="h-4 w-4 text-[color:var(--app-secondary-label)]"
                              aria-hidden
                            />
                          </button>
                          {directoryMenuOpen ? (
                            <div
                              role="menu"
                              data-testid="connect-directory-menu"
                              className="absolute left-0 top-full z-30 mt-1 w-[184px] overflow-hidden rounded-[14px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-standard)] p-1 shadow-[0_10px_30px_rgba(0,0,0,0.10)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                            >
                              {directoryMenuItems}
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {surface === "circles" ? (
              <ConnectCirclesTab
                onStateChange={setCirclesState}
                currentUserId={user?.uid ?? null}
                // The roster's Connect opens the SAME capability review the
                // directory opens, rather than sending outright.
                onRequestConnection={sendConnectRequest}
                onCancelConnectionRequest={cancelConnectionRequest}
                refreshToken={circleRefreshToken}
              />
            ) : (
              <>
                {tab === "nearby" ? (
                  <NearbyDirectories getIdToken={getIdToken} />
                ) : (
                  <div className="space-y-4 sm:space-y-5">
                    <SettingsGroup
                      title={
                        <span className={CONNECT_WRAPPING_TEXT_CLASSNAME}>
                          {connectionsHeading}
                        </span>
                      }
                      // Refresh sits in `titleAction`, not inside `title`. It used
                      // to be a child of the title node, which `SettingsGroup`
                      // renders inside an element carrying `role="heading"` -- and
                      // a control there is not a control. A screen reader folds its
                      // label into the heading's accessible name, so the heading
                      // announced as "Your connections Refresh contacts", and the
                      // button itself was never offered as something to press.
                      titleAction={
                        <Button
                          type="button"
                          variant="none"
                          effect="fade"
                          size="sm"
                          aria-label="Refresh contacts"
                          aria-busy={connectionsRefreshingFirstPage}
                          title="Refresh contacts"
                          disabled={connectionsRefreshingFirstPage}
                          onClick={handleRefreshConnections}
                          className={CONNECT_REFRESH_BUTTON_CLASSNAME}
                        >
                          <RefreshCw
                            aria-hidden="true"
                            className={cn(
                              "h-3.5 w-3.5",
                              connectionsRefreshingFirstPage && "animate-spin",
                            )}
                          />
                        </Button>
                      }
                      separatorInset
                      contentClassName={
                        sortedConnections.length > 0
                          ? CONNECT_DESKTOP_CONNECTION_LIST_CLASSNAME
                          : undefined
                      }
                      testId="connect-my-connections-group"
                    >
                      {sortedConnections.length === 0 ? (
                        <SettingsRow
                          // No description. "Connections appear here." explained what
                          // an empty list already showed, and the obvious replacement
                          // -- pointing at the search box -- is the sentence the
                          // directory section directly below already carries. Saying
                          // it twice on one screen is what made it noise the first
                          // time. The title is the whole message.
                          title={
                            isAdvisorTab ? "No RIAs yet" : "No connections yet"
                          }
                          density="compact"
                          disabled
                        />
                      ) : (
                        sortedConnections.map((connection) => (
                          <SettingsRow
                            key={connection.connectionId}
                            leading={
                              <ConnectionPersonAvatar
                                photoUrl={connection.photoUrl ?? null}
                                label={
                                  connection.displayName || connection.userId
                                }
                                verified={Boolean(connection.isRia)}
                              />
                            }
                            // Deliberately NOT stackTrailingOnMobile. That prop drops
                            // the trailing control onto its own line below the name on
                            // every phone (`sm:` is 640px, so "mobile" here is every
                            // iPhone), and it was doing so for a single 72px "Remove"
                            // that had room to sit inline all along -- a connection
                            // read as two rows, and the list lost its right-hand
                            // column. The People list below has never stacked; these
                            // two lists sit on the same screen and now agree.
                            title={
                              <span
                                className={CONNECT_WRAPPING_TITLE_ROW_CLASSNAME}
                              >
                                <span className={CONNECT_WRAPPING_TEXT_CLASSNAME}>
                                  {connection.displayName || connection.userId}
                                </span>
                                {connection.connectedFromContacts ? (
                                  <ContactSourceBadge />
                                ) : null}
                              </span>
                            }
                            // SettingsRow derives `data-voice-label` from a string
                            // title, and this one is an element so it can wrap with
                            // its provenance badge.
                            // Passing the name keeps the attribute the row already had.
                            voiceLabel={
                              connection.displayName || connection.userId
                            }
                            density="compact"
                            onClick={
                              connection.publicPersonRef
                                ? () =>
                                    router.push(
                                      buildPersonProfileRoute(
                                        connection.publicPersonRef!,
                                        { from: ROUTES.CONNECT },
                                      ),
                                    )
                                : undefined
                            }
                            trailing={
                              <span className="flex shrink-0 items-center justify-end gap-1.5 whitespace-nowrap">
                                {pendingRemoveId === connection.connectionId ? (
                                  <>
                                    <Button
                                      type="button"
                                      variant="destructive"
                                      effect="fill"
                                      size="sm"
                                      className={
                                        CONNECT_INLINE_BUTTON_CLASSNAME
                                      }
                                      disabled={
                                        busyId === connection.connectionId
                                      }
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleRemove(connection);
                                      }}
                                    >
                                      {busyId === connection.connectionId
                                        ? "Removing…"
                                        : "Confirm"}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="none"
                                      effect="fade"
                                      size="sm"
                                      className={
                                        CONNECT_INLINE_BUTTON_CLASSNAME
                                      }
                                      disabled={
                                        busyId === connection.connectionId
                                      }
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setPendingRemoveId(null);
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                  </>
                                ) : (
                                  <Button
                                    type="button"
                                    variant="none"
                                    effect="fade"
                                    size="sm"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setPendingRemoveId(
                                        connection.connectionId,
                                      );
                                    }}
                                    aria-label={`Remove connection with ${connection.displayName || connection.userId}`}
                                    className={cn(
                                      CONNECT_INLINE_BUTTON_CLASSNAME,
                                      "text-muted-foreground hover:text-destructive",
                                    )}
                                  >
                                    Remove
                                  </Button>
                                )}
                              </span>
                            }
                          />
                        ))
                      )}
                    </SettingsGroup>

                    {connectionsHasMore ? (
                      <div className="flex justify-center">
                        <Button
                          type="button"
                          variant="none"
                          effect="fill"
                          size="sm"
                          className={CONNECT_PAGER_BUTTON_CLASSNAME}
                          disabled={
                            connectionsLoadingMore ||
                            connectionsRefreshingFirstPage
                          }
                          onClick={() => void handleLoadMoreConnections()}
                        >
                          {connectionsLoadingMore
                            ? "Loading…"
                            : "Load more connections"}
                        </Button>
                      </div>
                    ) : null}

                    <div className="space-y-4">
                      <SettingsGroup
                        title={CONNECT_TAB_LABEL[tab]}
                        // People only. This one JSX node also renders the RIAs
                        // tab, where an address book has nothing to offer --
                        // an advisor is found by their verified profile, not
                        // by being in your phone. "Around you" never reaches
                        // here at all; that tab short-circuits to its own
                        // directories component.
                        //
                        // `available` is false on a desktop browser with no
                        // Google client configured, which is the one case
                        // where there is genuinely nothing to read. Hiding it
                        // there is kinder than a button that exists only to
                        // explain that it cannot work.
                        titleAction={
                          !isAdvisorTab && contactSync.available ? (
                            <Button
                              type="button"
                              variant="none"
                              effect="fade"
                              size="sm"
                              aria-label="Sync contacts"
                              aria-busy={contactSync.syncing}
                              title="Sync contacts"
                              disabled={contactSync.syncing}
                              onClick={() => void contactSync.sync()}
                              className={CONNECT_INLINE_BUTTON_CLASSNAME}
                            >
                              <BookUser
                                aria-hidden="true"
                                className="mr-1.5 h-3.5 w-3.5"
                              />
                              {contactSync.syncing
                                ? "Syncing\u2026"
                                : "Sync contacts"}
                            </Button>
                          ) : null
                        }
                        description={
                          isSelectionMode ? (
                            <span id="connect-selection-limit">
                              Pick up to {MAX_BULK_CONNECTION_REQUESTS}, across
                              pages.
                            </span>
                          ) : isAdvisorTab ? (
                            "Advisors with a verified profile."
                          ) : hasQuery ? (
                            "Send a request."
                          ) : (
                            "Search by name."
                          )
                        }
                        separatorInset
                        // The search row belongs to THIS list, so it is read after
                        // the heading that names the list -- not before it. It used
                        // to sit above "People", which put the sentence that
                        // instructs it ("Search by name.") underneath the box it
                        // instructs, and gave the reader a field before anything on
                        // screen had said what it searched. It still pins under the
                        // tab strips on scroll; it just no longer arrives first.
                        toolbar={
                          /* No `w-full` here any more, and it is load-bearing: this row
                    bleeds to the page gutters with a negative inline margin, and
                    `width: 100%` resolves against the text column, so the margin
                    only slid the row 16px left instead of widening it. A block
                    flex container fills its containing block on its own, and with
                    `auto` the margins can do their job. `cn` is tailwind-merge, so
                    a later `w-full` would have beaten anything the constant said.
                    Held by e2e/connect-sticky-header.layout.spec.ts. */
                          <div
                            data-testid="connect-search-row"
                            className={cn(
                              CONNECT_STICKY_SEARCH_CLASSNAME,
                              "block",
                            )}
                          >
                            <div className="relative">
                              <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-muted-foreground/80">
                                <SearchIcon className="h-4.5 w-4.5" />
                              </span>
                              <Input
                                ref={searchInputRef}
                                type="text"
                                value={query}
                              onChange={(event) => setQuery(event.target.value)}
                                placeholder={CONNECT_SEARCH_PLACEHOLDER}
                                aria-label="Search people"
                                data-voice-control-id="one-connect-search"
                                className={cn(
                                  CONNECT_SEARCH_INPUT_CLASSNAME,
                                  query
                                    ? CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME
                                    : CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME,
                                )}
                                enterKeyHint="search"
                                onKeyDown={(event) => {
                                  // iOS soft-keyboard "return" must dismiss the keyboard;
                                  // blurring the field is what actually closes it in the
                                  // Capacitor webview (there is no form submit here).
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                  }
                                }}
                                onFocus={(event) => {
                                  // Keyboard-dismiss "on drag": the first scroll/drag while
                                  // the field is focused blurs it, so an open keyboard never
                                  // locks the results out of view. Scoped to this field's
                                  // focus lifecycle and cleaned up on blur.
                                  const field = event.currentTarget;
                                  // Scroll the field into view above the on-screen keyboard.
                                  // Tapping it otherwise leaves it hidden behind the keyboard
                                  // until the user manually scrolls up. The delay lets the
                                  // keyboard animate in so the shrunken viewport is measured.
                                  window.setTimeout(() => {
                                    field.scrollIntoView({
                                      block: "center",
                                      behavior: "smooth",
                                    });
                                  }, 300);
                                  const dismiss = () => field.blur();
                                window.addEventListener("touchmove", dismiss, {
                                      passive: true,
                                      once: true,
                                });
                                  field.addEventListener(
                                    "blur",
                                    () =>
                                      window.removeEventListener(
                                        "touchmove",
                                        dismiss,
                                      ),
                                    { once: true },
                                  );
                                }}
                              />
                              {query ? (
                                <button
                                  type="button"
                                  aria-label="Clear search"
                                  onClick={() => {
                                    setQuery("");
                                    searchInputRef.current?.focus();
                                  }}
                                  className="press-scale absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#1d1d1f] transition-colors hover:text-black dark:text-white"
                                >
                                  <X className="h-5 w-5" strokeWidth={2.4} />
                                </button>
                              ) : null}
                            </div>
                          </div>
                        }
                      >
                        {loading && people.length === 0 ? (
                          <SettingsRow
                            title="Finding people…"
                            density="compact"
                            disabled
                          />
                        ) : error ? (
                          <SettingsRow
                            title={
                              isAdvisorTab
                                ? "Advisors are unavailable"
                                : "People are unavailable"
                            }
                            description={error}
                            density="compact"
                            tone="destructive"
                          />
                        ) : people.length === 0 ? (
                          // Tested against the list that is actually rendered below,
                          // never against the raw server page. Those were two
                          // different lists once: the server returned 8 rows, a
                          // client-side filter hid all 8, and this branch checked the
                          // 8 -- so the "no one matches" row never appeared and the
                          // section rendered as blank space under its own heading.
                          // An empty result has to say so.
                          hasQuery ? (
                            <>
                              <SettingsRow
                                title={`No one matches "${trimmedQuery}"`}
                                description={
                                  isAdvisorTab
                                    ? "Try People, or their full name."
                                    : "Try their full name."
                                }
                                density="compact"
                                disabled
                              />
                              {/* The row above states a fact, so it stays inert; an
                          invite is a separate offer and gets its own row
                          rather than making "No one matches Bob" tappable.
                          Read together they are the two things left to try:
                          spell it out, or bring them here. */}
                              {canInviteToOne ? (
                                <SettingsRow
                                  icon={Share2}
                                  iconTone="blue"
                                  title="Invite them to One"
                                  description="Send them the app. You can connect once they join."
                                  density="compact"
                                  onClick={() => {
                                    void handleInviteToOne();
                                  }}
                                  testId="connect-invite-to-one"
                                />
                              ) : null}
                            </>
                          ) : (
                            <SettingsRow
                              title={
                                isAdvisorTab
                                  ? "No advisors yet"
                                  : "No people yet"
                              }
                              description="Search by name."
                              density="compact"
                              disabled
                            />
                          )
                        ) : (
                          people.map((person) => {
                            const cta = relationshipCta(person.relationship);
                            const title =
                              person.displayName ||
                              person.email ||
                              person.userId;
                            const description =
                              getDirectoryPersonDescription(person);
                            const isSelected = selectedPeople.has(
                              person.userId,
                            );
                            return (
                              <SettingsRow
                                key={person.userId}
                                // Verified is a state, and green is what this design
                                // system already spends on a verified one. It is on the
                                // row rather than on the tab so the mark still means
                                // something in a search that spans both.
                                leading={
                                  <ConnectionPersonAvatar
                                    photoUrl={person.photoUrl}
                                    label={title}
                                    verified={Boolean(person.isRia)}
                                  />
                                }
                                title={
                                  <span className={CONNECT_WRAPPING_TEXT_CLASSNAME}>
                                    {title}
                                  </span>
                                }
                                description={
                                  description ? (
                                    <span className={CONNECT_WRAPPING_TEXT_CLASSNAME}>
                                      {description}
                                    </span>
                                  ) : undefined
                                }
                                density="compact"
                                onClick={
                                  !isSelectionMode && person.publicPersonRef
                                    ? () =>
                                        router.push(
                                          buildPersonProfileRoute(
                                            person.publicPersonRef!,
                                            { from: ROUTES.CONNECT },
                                          ),
                                        )
                                    : undefined
                                }
                                trailing={
                                  isSelectionMode ? (
                                    // A disabled checkbox alone said nothing about WHY.
                                    // Someone already connected, already asked, or
                                    // already asking you looked identical to someone
                                    // selection had simply run out of room for -- both
                                    // rendered as the same greyed box with a
                                    // not-allowed cursor and no visible text. A row
                                    // ineligible because of its relationship isn't a
                                    // choice at all, so it gets no checkbox -- just the
                                    // reason, standing in its place. The limit case
                                    // stays a real (disabled) checkbox, since it flips
                                    // back to selectable the moment the reader frees a
                                    // slot, and it already has a persistent explanation
                                    // in the section description above the list.
                                    person.relationship !== "none" ? (
                                      <span
                                        className="text-xs font-medium text-emerald-700 dark:text-emerald-300"
                                        aria-label={`${title}: ${cta.label}, not selectable`}
                                      >
                                        {cta.label}
                                      </span>
                                    ) : (
                                      <Checkbox
                                        checked={isSelected}
                                        disabled={
                                          !isSelected &&
                                          selectedPeople.size >=
                                            MAX_BULK_CONNECTION_REQUESTS
                                        }
                                        // The default unchecked border (border-input)
                                        // reads as near-invisible on this row's light
                                        // background -- readers couldn't tell an
                                        // eligible, clickable checkbox from empty
                                        // space. A darker, thicker border only changes
                                        // that idle state; data-[state=checked] still
                                        // wins once picked.
                                        className="border-2 border-foreground/50"
                                        aria-describedby="connect-selection-limit"
                                        onCheckedChange={(checked) => {
                                          if (
                                            checked &&
                                            selectedPeople.size >=
                                              MAX_BULK_CONNECTION_REQUESTS
                                          ) {
                                            toast.error(
                                              `You can select up to ${MAX_BULK_CONNECTION_REQUESTS} people.`,
                                            );
                                            setShowLimitBanner(true);
                                            return;
                                          }
                                          setSelectedPeople((current) => {
                                            const next = new Map(current);
                                            if (checked) {
                                              // The whole row, not the id: this person
                                              // has to survive the reader turning the
                                              // page away from them.
                                              next.set(person.userId, person);
                                            } else {
                                              next.delete(person.userId);
                                              if (
                                                next.size <
                                                MAX_BULK_CONNECTION_REQUESTS
                                              ) {
                                                setShowLimitBanner(false);
                                              }
                                            }
                                            return next;
                                          });
                                        }}
                                        aria-label={`Select ${title}`}
                                      />
                                    )
                                  ) : person.relationship ===
                                    "pending_outgoing" ? (
                                    <Button
                                      type="button"
                                      variant="none"
                                      effect="fill"
                                      size="sm"
                                      // One word at the width of every other action in
                                      // this column. "Cancel request" plus a 100px
                                      // floor sized for "Cancelling…" made the widest
                                      // control on the screen the one belonging to the
                                      // least common row state -- 116px of a 375px row,
                                      // against 72px for Connect directly above it. The
                                      // in-flight state is a spinner in the same box
                                      // rather than a longer word, so the row never
                                      // reflows mid-tap. `loading` also sets aria-busy.
                                      className={cn(
                                        CONNECT_ROW_ACTION_CLASSNAME,
                                        "w-[72px] px-0",
                                      )}
                                      loading={busyId === person.userId}
                                      aria-label={`Cancel your request to ${title}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void cancelConnectionRequest(person);
                                      }}
                                    >
                                      {busyId === person.userId ? (
                                        <Loader2
                                          className="h-4 w-4 animate-spin"
                                          aria-hidden="true"
                                        />
                                      ) : (
                                        "Cancel"
                                      )}
                                    </Button>
                                  ) : (
                                    <Button
                                      type="button"
                                      variant="none"
                                      effect="fill"
                                      size="sm"
                                      className={cn(
                                        CONNECT_ROW_ACTION_CLASSNAME,
                                        "min-w-[72px]",
                                      )}
                                      disabled={
                                        cta.disabled || busyId === person.userId
                                      }
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleConnect(person);
                                      }}
                                    >
                                      {busyId === person.userId
                                        ? "Sending..."
                                        : cta.label}
                                    </Button>
                                  )
                                }
                              />
                            );
                          })
                        )}
                        {people.length > 0 && hasMore ? (
                          <div
                            ref={loadMoreDirectoryRef}
                            className="flex min-h-14 items-center justify-center border-t border-[color:var(--app-card-border-standard)] px-4 py-2"
                            data-testid="connect-load-more-row"
                            aria-live="polite"
                          >
                            {isDirectoryRefreshing ? (
                              <span className="inline-flex items-center gap-2 text-[14px] font-medium leading-5 text-[color:var(--app-secondary-label)]">
                                <Loader2
                                  className="h-3.5 w-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                                Loading more…
                              </span>
                            ) : (
                              <Button
                                type="button"
                                variant="none"
                                effect="fade"
                                size="sm"
                                showRipple={false}
                                aria-label={`Load ${DEFAULT_PAGE_SIZE} more people`}
                                className={CONNECT_PAGER_BUTTON_CLASSNAME}
                                onClick={loadNextDirectoryBatch}
                              >
                                Load {DEFAULT_PAGE_SIZE} more
                              </Button>
                            )}
                          </div>
                        ) : people.length > 0 ? (
                          <span className="sr-only">All people loaded</span>
                        ) : null}
                        {isSelectionMode &&
                          selectedPeople.size > 0 &&
                          batchConnectDraft === null && (
                            <div className="flex justify-center border-t border-[color:var(--app-card-border-standard)] px-3 py-4">
                              <Button
                                type="button"
                                variant="blue"
                                effect="fill"
                                disabled={isConnectingMultiple}
                                onClick={() => {
                                  // Everyone picked, not everyone picked who is still on
                                  // screen. Reading the selection back off the rendered
                                  // page is what dropped page one's picks on reaching
                                  // page two.
                                  void openBatchConnectDraft([
                                    ...selectedPeople.values(),
                                  ]);
                                }}
                              >
                                {`Review ${selectedPeople.size}`}
                              </Button>
                            </div>
                          )}
                      </SettingsGroup>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
            </SurfaceStack>
          </AppPageContentRegion>
        </>      )}

      <Dialog
        open={batchConnectDraft !== null}
        onOpenChange={(open) => {
          if (!open && !isConnectingMultiple) setBatchConnectDraft(null);
        }}
      >
        <DialogContent className="gap-5 max-h-[85vh] flex flex-col overflow-hidden bg-[color:var(--app-card-surface-default-solid)]">
          <div className="shrink-0 space-y-5">
            <DialogHeader className="text-left">
              <DialogTitle>Send connection requests</DialogTitle>
              {/*
                This said "This only sends a connection request." That was true
                while the bulk path could not carry capabilities. It can now, so
                the sentence became a promise the sheet no longer keeps whenever
                a Pick is ticked below. Matches the one-person sheet's wording,
                which is accurate either way.
              */}
              <DialogDescription>
                Start safe. Add sharing only if you choose.
              </DialogDescription>
            </DialogHeader>
          </div>

          {batchConnectDraft ? (
            <div className="space-y-4 overflow-y-auto min-h-0 flex-1 px-1 pb-2">
              <SettingsGroup title="Selected people" separatorInset>
                {batchConnectDraft.people.map((person) => {
                  const title =
                    person.displayName || person.email || person.userId;
                  return (
                    <SettingsRow
                      key={`batch-${person.userId}`}
                      leading={
                        <ConnectionPersonAvatar
                          photoUrl={person.photoUrl}
                          label={title}
                          verified={Boolean(person.isRia)}
                        />
                      }
                      title={
                        <span className={CONNECT_WRAPPING_TEXT_CLASSNAME}>
                          {title}
                        </span>
                      }
                      density="compact"
                      trailing={
                        <Button
                          type="button"
                          variant="none"
                          effect="fade"
                          size="sm"
                          disabled={isConnectingMultiple}
                          onClick={() => {
                            setBatchConnectDraft((current) => {
                              if (!current) return current;
                              const updated = current.people.filter(
                                (p) => p.userId !== person.userId,
                              );
                              if (updated.length === 0) {
                                return null;
                              }
                              const {
                                [person.userId]: _dropped,
                                ...remainingHandles
                              } = current.requestedHandles;
                              return {
                                ...current,
                                people: updated,
                                requestedHandles: remainingHandles,
                              };
                            });
                            // Keep the underlying selection synchronized so the UI
                            // doesn't show them checked if the dialog is closed.
                            setSelectedPeople((current) => {
                              const next = new Map(current);
                              next.delete(person.userId);
                              return next;
                            });
                          }}
                          className="h-8 rounded-[10px] px-3 text-[13px] font-medium text-muted-foreground hover:text-destructive"
                        >
                          Remove
                        </Button>
                      }
                    />
                  );
                })}
              </SettingsGroup>

              {batchConnectDraft.loadingCatalogs ? (
                <SettingsGroup title="Connection access" separatorInset>
                  <SettingsRow
                    title="Checking what they can share…"
                    density="compact"
                    disabled
                  />
                </SettingsGroup>
              ) : batchRequestableRows.length > 0 ? (
                // One row per person per capability, because a handle is only
                // valid for its own owner. Asking four advisors for Picks is
                // four separate asks, and each is shown as one.
                <SettingsGroup
                  title="Ask from them"
                  description="Optional. Each person can decline."
                  separatorInset
                >
                  {batchRequestableRows.map((row) => (
                    <SettingsRow
                      key={`batch-request-${row.userId}-${row.item.handle}`}
                      icon={BadgeCheck}
                      iconTone="green"
                      title={
                        <span className={CONNECT_WRAPPING_TEXT_CLASSNAME}>
                          {row.title}
                        </span>
                      }
                      description={row.item.label}
                      density="compact"
                      trailing={
                        <Checkbox
                          checked={(
                            batchConnectDraft.requestedHandles[row.userId] ?? []
                          ).includes(row.item.handle)}
                          disabled={isConnectingMultiple}
                          className="border-2 border-foreground/50"
                          onCheckedChange={(checked) =>
                            toggleBatchRequestedHandle(
                              row.userId,
                              row.item.handle,
                              checked === true,
                            )
                          }
                          aria-label={`Ask ${row.title} for ${row.item.label}`}
                        />
                      }
                    />
                  ))}
                </SettingsGroup>
              ) : null}

              {!batchConnectDraft.loadingCatalogs &&
              batchOfferableItems.length > 0 ? (
                // Not per person: these handles are the caller's own, so one
                // choice is the same offer to everyone selected.
                <SettingsGroup
                  title="Offer now"
                  description="Offered to everyone selected. They approve first."
                  separatorInset
                >
                  {batchOfferableItems.map((item) => (
                    <SettingsRow
                      key={`batch-offer-${item.handle}`}
                      title={item.label}
                      description={item.description}
                      density="compact"
                      trailing={
                        <Checkbox
                          checked={batchConnectDraft.offeredHandles.includes(
                            item.handle,
                          )}
                          disabled={isConnectingMultiple}
                          className="border-2 border-foreground/50"
                          onCheckedChange={(checked) =>
                            toggleBatchOfferedHandle(
                              item.handle,
                              checked === true,
                            )
                          }
                          aria-label={`Offer ${item.label}`}
                        />
                      }
                    />
                  ))}
                </SettingsGroup>
              ) : null}

              {!batchConnectDraft.loadingCatalogs &&
              batchRequestableRows.length === 0 &&
              batchOfferableItems.length === 0 ? (
                <SettingsGroup title="Connection access" separatorInset>
                  <SettingsRow
                    icon={Lock}
                    iconTone="gray"
                    title="No access yet"
                    description="These only send requests."
                    density="compact"
                    disabled
                  />
                </SettingsGroup>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="shrink-0 w-full flex-row items-center justify-between gap-3 sm:justify-between">
            <Button
              type="button"
              variant="none"
              effect="fade"
              className="min-w-[96px]"
              disabled={isConnectingMultiple}
              onClick={() => setBatchConnectDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="blue"
              effect="fill"
              className="min-w-[148px]"
              // Held until the catalogs land. Sending first is not a slower
              // version of the same thing -- it is a send with no picks
              // attached, reported as a success, which is the exact failure
              // this sheet exists to end.
              disabled={
                !batchConnectDraft ||
                isConnectingMultiple ||
                batchConnectDraft.loadingCatalogs
              }
              onClick={() => void handleConnectMultiple()}
            >
              {/*
                A disabled Button in this system still renders full Action
                Blue, so a held button that kept its ready label would look
                tappable and read as a dead tap. The label carries the state
                instead of the colour.
              */}
              {isConnectingMultiple
                ? "Sending…"
                : batchConnectDraft?.loadingCatalogs
                  ? "Checking…"
                  : "Send requests"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ContactSyncResultsSheet
        {...contactSync.resultsSheetProps}
        onRequestConnection={requestConnectionFromContactMatch}
      />

      {showLimitBanner && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[9999] w-[92%] max-w-md rounded-2xl bg-popover/95 backdrop-blur-md p-3.5 shadow-xl border border-border/50 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-3 duration-200">
          <span className="text-xs font-medium text-foreground">
            You can connect up to {MAX_BULK_CONNECTION_REQUESTS} at a time.
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="sm"
              className="h-7 rounded-xl px-2.5 text-xs font-normal text-muted-foreground hover:bg-muted"
              onClick={() => setShowLimitBanner(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="blue"
              effect="fill"
              size="sm"
              className="h-7 rounded-xl px-3 text-xs font-medium"
              onClick={() => {
                setShowLimitBanner(false);
                if (selectedPeople.size === 0) return;
                void openBatchConnectDraft([...selectedPeople.values()]);
              }}
            >
              Review
            </Button>
          </div>
        </div>
      )}
    </AppPageShell>
  );
}
