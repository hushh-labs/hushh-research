"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search as SearchIcon, UserRound, Users } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NearbyDirectories } from "@/components/connect/nearby-directories";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRequireAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
import {
  ConnectionsService,
  type ConnectionInformationScopeCatalog,
  type ConnectionRelationship,
  type ConnectionScopeCatalog,
  type ConnectionSummaryEntry,
  type DirectoryPerson,
} from "@/lib/services/connections-service";
import { relationshipCta } from "@/lib/connections/relationship-label";
import { VOICE_DISAMBIGUATION_DATA_KEY } from "@/lib/voice/voice-disambiguation";
import { getDirectoryPersonDescription } from "./directory-person-label";

type ConnectTab = "people" | "nearby";

const CONNECT_TABS = [
  { value: "people", label: "People" },
  { value: "nearby", label: "Around you" },
];

/**
 * How many people the unsearched People tab offers.
 *
 * Deliberately about a screen's worth. It exists so someone who has just joined
 * and knows nobody's exact name is not staring at an empty surface — not so
 * they can browse the register, which is the thing that stops scaling.
 */
const SUGGESTED_PEOPLE_LIMIT = 8;

/**
 * How many people a page shows, and the sizes the reader can pick.
 *
 * #5020 answered "the directory is unusably long" with a fixed sample that
 * deliberately refused to page. That solved the first screenful and left no way
 * through the rest, so this replaces it with real paging: the default is still
 * a screenful, and someone who wants to scan more can say so.
 */
const PAGE_SIZE_OPTIONS = [8, 16, 24, 50] as const;
const DEFAULT_PAGE_SIZE = SUGGESTED_PEOPLE_LIMIT;

/** Maximum number of connection requests the People bulk action can send. */
const MAX_BULK_CONNECTION_REQUESTS = 20;

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
  const named = rows.filter((row) => normalize(String(nameOf(row) ?? "")).length > 0);

  const exact = named.filter((row) => normalize(String(nameOf(row))) === target);
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
    const nameWords = normalize(String(nameOf(row))).split(" ").filter(Boolean);
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

export default function ConnectPageClient() {
  const { user } = useRequireAuth();
  const router = useRouter();

  const [tab, setTab] = useState<ConnectTab>("people");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);

  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [connections, setConnections] = useState<ConnectionSummaryEntry[]>([]);
  const [outgoingRequestIds, setOutgoingRequestIds] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [informationScopeDraft, setInformationScopeDraft] = useState<{
    connection: ConnectionSummaryEntry;
    catalog: ConnectionInformationScopeCatalog;
  } | null>(null);
  const [informationScopeQuery, setInformationScopeQuery] = useState("");
  const [scopeDraft, setScopeDraft] = useState<{
    person: DirectoryPerson;
    catalog: ConnectionScopeCatalog;
    requestedHandles: string[];
    offeredHandles: string[];
  } | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [isConnectingMultiple, setIsConnectingMultiple] = useState(false);

  const getIdToken = useCallback(
    async () => (user ? await user.getIdToken() : null),
    [user],
  );

  const loadConnections = useCallback(async (): Promise<
    ConnectionSummaryEntry[]
  > => {
    if (!user) return [];
    try {
      const idToken = await user.getIdToken();
      return await ConnectionsService.listConnections({ idToken });
    } catch {
      /* non-fatal: connections section stays empty */
      return [];
    }
  }, [user]);

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

  useEffect(() => {
    let cancelled = false;
    void loadConnections().then((rows) => {
      if (!cancelled) setConnections(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [loadConnections]);

  useEffect(() => {
    void loadOutgoingRequestIds();
  }, [loadOutgoingRequestIds]);

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
  useEffect(() => {
    setCurrentPage(1);
  }, [trimmedQuery, pageSize]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user) return;
      try {
        setHasMore(false);
        setLoading(true);
        setError(null);
        const idToken = await user.getIdToken();
        const page = await ConnectionsService.searchDirectory({
          idToken,
          query: trimmedQuery,
          page: currentPage,
          limit: pageSize,
        });
        if (!cancelled) {
          // One page replaces the last. Appending was what made the directory
          // an endless scroll with no sense of position in it.
          setPeople(page.items);
          setHasMore(page.hasMore);
          // Selections are counted on the "Connect to Selected (N)" button, so
          // drop any that this result set no longer shows — an N the reader
          // cannot see is a promise the surface can't account for.
          setSelectedUserIds((current) => {
            if (current.size === 0) return current;
            const visible = new Set(page.items.map((person) => person.userId));
            const next = new Set(
              [...current].filter((userId) => visible.has(userId)),
            );
            return next.size === current.size ? current : next;
          });
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
  }, [user, trimmedQuery, currentPage, pageSize]);

  const goToPage = useCallback(
    (next: number) => {
      if (loading || next < 1) return;
      // `hasMore` is the only forward signal the directory gives, so a next
      // page is offered exactly when the server says one exists.
      if (next > currentPage && !hasMore) return;
      setCurrentPage(next);
    },
    [currentPage, hasMore, loading],
  );

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
        setScopeDraft(null);
        CacheSyncService.onConnectionCapabilityMutated(user.uid);
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
      if (!user) return;
      try {
        setBusyId(person.userId);
        const idToken = await user.getIdToken();
        const catalog = await ConnectionsService.getScopeCatalog({
          idToken,
          counterpartUserId: person.userId,
        });
        setScopeDraft({
          person,
          catalog,
          // A requested capability belongs to the counterpart, so it must be
          // an intentional sender choice and still needs recipient approval.
          // Never imply a request merely because a capability is eligible.
          requestedHandles: [],
          offeredHandles: [],
        });
      } catch (catalogError) {
        toast.error(
          catalogError instanceof Error
            ? catalogError.message
            : "Could not prepare this connection request",
        );
      } finally {
        setBusyId((current) => (current === person.userId ? null : current));
      }
    },
    [user],
  );

  const handleConnect = useCallback(
    (person: DirectoryPerson) => {
      if (!user) return;
      const cta = relationshipCta(person.relationship);
      if (cta.action === "respond") {
        router.push(buildConsentCenterHref("pending"));
        return;
      }
      if (cta.action === "connect") void sendConnectRequest(person);
    },
    [router, sendConnectRequest, user],
  );

  const toggleDraftHandle = useCallback(
    (
      direction: "requestedHandles" | "offeredHandles",
      handle: string,
      checked: boolean,
    ) => {
      setScopeDraft((current) => {
        if (!current) return current;
        const nextHandles = checked
          ? [...new Set([...current[direction], handle])]
          : current[direction].filter((candidate) => candidate !== handle);
        return { ...current, [direction]: nextHandles };
      });
    },
    [],
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
        setConnections((prev) =>
          prev.filter((c) => c.connectionId !== connection.connectionId),
        );
        CacheSyncService.onConnectionCapabilityMutated(user.uid);
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
    [user],
  );

  const viewInformationScopes = useCallback(
    async (connection: ConnectionSummaryEntry) => {
      if (!user) return;
      try {
        setBusyId(connection.connectionId);
        const idToken = await user.getIdToken();
        const catalog = await ConnectionsService.searchInformationScopes({
          idToken,
          counterpartUserId: connection.userId,
          limit: 50,
        });
        setInformationScopeQuery("");
        setInformationScopeDraft({ connection, catalog });
      } catch (scopeError) {
        toast.error(
          scopeError instanceof Error
            ? scopeError.message
            : "Could not load available scopes",
        );
      } finally {
        setBusyId(null);
      }
    },
    [user],
  );

  const visibleInformationScopes = informationScopeDraft?.catalog.items.filter(
    (item) => {
      const query = informationScopeQuery.trim().toLowerCase();
      return !query || `${item.label ?? ""} ${item.scope}`.toLowerCase().includes(query);
    },
  );

  const handleConnectMultiple = useCallback(async () => {
    if (!user || selectedUserIds.size === 0) return;
    const selectedPeople = people.filter((p) => selectedUserIds.has(p.userId));

    // Keep the dispatch boundary bounded even if selection state is restored or
    // changed outside the row controls.
    if (selectedPeople.length > MAX_BULK_CONNECTION_REQUESTS) {
      toast.error(`Select no more than ${MAX_BULK_CONNECTION_REQUESTS} people at a time.`);
      return;
    }

    setIsConnectingMultiple(true);
    let successCount = 0;
    const successfulUserIds = new Set<string>();
    
    try {
      const idToken = await user.getIdToken();
      for (const person of selectedPeople) {
        if (person.relationship === "none") {
          try {
            const request = await ConnectionsService.sendRequest({
              idToken,
              addresseeUserId: person.userId,
              requestedScopeHandles: [],
              offeredScopeHandles: [],
            });
            setOutgoingRequestIds((current) => ({
              ...current,
              [person.userId]: request.id,
            }));
            successfulUserIds.add(person.userId);
            successCount++;
          } catch (_err) {
            console.error(`Failed to send request to ${person.userId}`, _err);
          }
        }
      }
      
      setPeople((prev) =>
        prev.map((p) =>
          successfulUserIds.has(p.userId) && p.relationship === "none"
            ? { ...p, relationship: "pending_outgoing" }
            : p,
        ),
      );
      
      if (successCount > 0) {
        CacheSyncService.onConnectionCapabilityMutated(user.uid);
        toast.success(`Sent ${successCount} connection request${successCount !== 1 ? 's' : ''}`);
      } else {
        toast.error("Failed to send requests or they were already sent.");
      }
    } catch (_err) {
      toast.error("An error occurred while sending requests.");
    } finally {
      setIsConnectingMultiple(false);
      setIsSelectionMode(false);
      setSelectedUserIds(new Set());
    }
  }, [user, selectedUserIds, people]);

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
  // Present the People directory in the same predictable order as connections:
  // alphabetical (A-Z) by the visible name, case/accent-insensitive. When a
  // search query is active, names that START with the query rank above inner
  // matches (so "Ab" surfaces "Abdul" before "Zab…"), then A-Z within each
  // group. The server can return directory rows in relevance/insertion order,
  // which read as unsorted in the list; this makes the rendered order stable.
  const sortedPeople = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    const nameOf = (person: DirectoryPerson) =>
      (person.displayName || person.email || person.userId)
        .trim()
        .toLowerCase();
    return [...people].sort((a, b) => {
      const nameA = nameOf(a);
      const nameB = nameOf(b);
      if (q) {
        const startsA = nameA.startsWith(q);
        const startsB = nameB.startsWith(q);
        if (startsA !== startsB) return startsA ? -1 : 1;
      }
      return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
    });
  }, [people, trimmedQuery]);

  const sortedConnections = useMemo(
    () =>
      [...connections].sort((a, b) =>
        (a.displayName || a.userId).localeCompare(
          b.displayName || b.userId,
          undefined,
          { sensitivity: "base" },
        ),
      ),
    [connections],
  );

  // Voice surface for Connect. Until this existed the route derived the
  // generic "app" screen, so One knew a person was somewhere in the app and
  // nothing more -- and Connect could not be named as a destination, which is
  // why an empty people list elsewhere had nowhere to send anyone.
  const connectVoiceSurfaceMetadata = useMemo(
    () => ({
      screenId: "connect",
      title: "Connect",
      purpose:
        "This screen finds people, sends connection requests, and manages who you are connected to.",
      // The subjects here are people, by name and email. None of that is safe
      // to say aloud, so this screen names only itself.
      primaryEntity: null,
      selectedEntity: null,
      spokenSubject: tab === "nearby" ? "Connect, Around you tab" : "Connect, People tab",
      sections: [
        { id: "people", title: "People", purpose: "Search everyone you could connect with, and manage existing connections." },
        { id: "nearby", title: "Around you", purpose: "Find verified advisors and insurance agents, and businesses, near your current location." },
      ],
      actions: [
        { id: "connect.open_people", actionId: "connect.open_people", label: "Open Connect people", purpose: "Show connections and the people directory." },
        { id: "connect.open_nearby", actionId: "connect.open_nearby", label: "Open advisors around you", purpose: "Show advisors near you." },
        { id: "connect.search_people", actionId: "connect.search_people", label: "Search for someone to connect with", purpose: "Search the directory for the spoken name." },
        { id: "connect.send_request", actionId: "connect.send_request", label: "Send a connection request", purpose: "Send a request to one exact name after the person confirms by voice." },
      ],
      // Only the search box carries a `data-voice-control-id` anchor. The tab
      // strip is the shared SegmentedTabs, which has no per-option control id,
      // so claiming one here would describe a hook that does not exist.
      controls: [
        { id: "one-connect-search", label: "Search people", purpose: "Search the directory by name.", actionId: "connect.search_people", role: "textbox" },
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
      activeSection: tab === "nearby" ? "Around you" : "People",
      activeTab: tab,
      visibleModules:
        tab === "nearby"
          ? ["Advisors near you", "Insurance agents near you", "Places near you"]
          : ["Your connections", "People directory"],
      focusedWidget: tab === "nearby" ? "Around you tab" : "People tab",
      availableActions: ["Open Connect people", "Open advisors around you", "Search for someone to connect with"],
      activeControlId: null,
      lastInteractedControlId: null,
      busyOperations: loading ? ["connect_directory_load"] : [],
      // Counts only -- never who.
      screenMetadata: {
        connect_tab: tab,
        connection_count: connections.length,
        has_load_error: Boolean(error),
        searching: query.trim().length > 0,
      },
    }),
    [connections.length, error, loading, query, tab],
  );
  usePublishVoiceSurfaceMetadata(connectVoiceSurfaceMetadata);

  useLocalOnboardingActionHandler("connect.open_people", () => {
    setTab("people");
    return { status: "succeeded", summary: "Connect people opened." };
  });
  useLocalOnboardingActionHandler("connect.open_nearby", () => {
    setTab("nearby");
    return { status: "succeeded", summary: "Advisors around you opened." };
  });
  useLocalOnboardingActionHandler("connect.search_people", (slots) => {
    // The model provides only the words it heard. This mounted surface resolves
    // those words against the directory it already holds; no account id or
    // contact information crosses the voice boundary.
    const person = typeof slots.person === "string" ? slots.person.trim() : "";
    if (!person) {
      return { status: "blocked", summary: "Say the name to search for in Connect." };
    }
    setTab("people");
    setQuery(person);
    searchInputRef.current?.focus();
    return { status: "succeeded", summary: "Searching Connect for the name you gave." };
  });
  useLocalOnboardingActionHandler("connect.send_request", async (slots) => {
    const spokenName = typeof slots.person === "string" ? slots.person.trim() : "";
    // Set only by the disambiguation card, which resolves a name the person
    // already saw into the one account they pointed at. It skips the matcher
    // entirely rather than re-running it: the ambiguity has been settled by a
    // human, and re-deriving it from the same words would just fail the same
    // way and bounce the card straight back.
    const chosenUserId = typeof slots.userId === "string" ? slots.userId.trim() : "";
    if (!user) {
      return { status: "blocked", summary: "Sign in before sending a connection request." };
    }
    if (!spokenName && !chosenUserId) {
      return { status: "blocked", summary: "Say the person's full name before sending a request." };
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
      for (let pageNumber = 1; pageNumber <= DIRECTORY_RESOLVE_MAX_PAGES; pageNumber += 1) {
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
                // Whatever the directory can show; contact sync will make this
                // a phone number for some of these people.
                detail: c.email || null,
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
          summary: `${person.displayName} has already asked to connect with you. Open Connect and accept their request instead of sending one back.`,
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
        return { status: "failed", summary: "Could not send the connection request." };
      }
      return {
        status: "succeeded",
        summary: `Connection request sent to ${person.displayName}.`,
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
    const spokenName = typeof slots.person === "string" ? slots.person.trim() : "";
    if (!user) {
      return { status: "blocked", summary: "Sign in before cancelling a request." };
    }
    if (!spokenName) {
      return { status: "blocked", summary: "Say whose request you want to cancel." };
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
      const matches = matchByName(outgoing, spokenName, (request) =>
        request.counterpartDisplayName,
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
          error instanceof Error ? error.message : "Could not cancel that request.",
      };
    }
  });

  useLocalOnboardingActionHandler("connect.remove_connection", async (slots) => {
    const spokenName = typeof slots.person === "string" ? slots.person.trim() : "";
    if (!user) {
      return { status: "blocked", summary: "Sign in before removing a connection." };
    }
    if (!spokenName) {
      return { status: "blocked", summary: "Say who you want to remove." };
    }
    try {
      const idToken = await user.getIdToken();
      const existing = await ConnectionsService.listConnections({ idToken });
      const matches = matchByName(existing, spokenName, (entry) => entry.displayName);
      if (matches.length === 0) {
        return {
          status: "blocked",
          summary: `${spokenName} is not one of your connections.`,
        };
      }
      if (matches.length > 1) {
        return {
          status: "blocked",
          summary: `More than one connection matches that name: ${matches
            .map((entry) => entry.displayName ?? "someone")
            .join(", ")}. Say which one.`,
        };
      }
      const connection = matches[0]!;
      await ConnectionsService.removeConnection({
        idToken,
        connectionId: connection.connectionId,
      });
      setConnections((prev) =>
        prev.filter((c) => c.connectionId !== connection.connectionId),
      );
      CacheSyncService.onConnectionCapabilityMutated(user.uid);
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
          error instanceof Error ? error.message : "Could not remove that connection.",
      };
    }
  });

  return (
    <AppPageShell
      as="main"
      fitContent

      width="reading"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/connect",
        marker: "native-route-connect",
        authState: user ? "authenticated" : "pending",
        dataState: error
          ? "unavailable-valid"
          : loading
            ? "loading"
            : people.length === 0
              ? "empty-valid"
              : "loaded",
        errorCode: error ? "connect_directory_unavailable" : null,
        errorMessage: error,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader title="Connect" accent="neutral" />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <div className="space-y-4 sm:space-y-5">
            <SegmentedTabs
              value={tab}
              onValueChange={(value) => setTab(value as ConnectTab)}
              options={CONNECT_TABS}
            />

            {tab === "nearby" ? (
              <NearbyDirectories getIdToken={getIdToken} />
            ) : (
              <div className="space-y-4 sm:space-y-5">
            <SettingsGroup
              title={`My connections (${connections.length})`}
              separatorInset
            >
              {connections.length === 0 ? (
                <SettingsRow
                  title="No connections yet"
                  description="People you connect with will appear here."
                  density="compact"
                  disabled
                />
              ) : (
                sortedConnections.map((connection) => (
                  <SettingsRow
                    key={connection.connectionId}
                    icon={Users}
                    iconTone="blue"
                    stackTrailingOnMobile
                    title={connection.displayName || connection.userId}
                    density="compact"
                    trailing={
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="none"
                          effect="fade"
                          size="sm"
                          className="h-8 rounded-[10px] px-3 text-[13px] font-medium"
                          disabled={busyId === connection.connectionId}
                          onClick={() => void viewInformationScopes(connection)}
                        >
                          {busyId === connection.connectionId ? "Loading…" : "Scopes"}
                        </Button>
                        {pendingRemoveId === connection.connectionId ? (
                          <>
                            <Button
                              type="button"
                              variant="destructive"
                              effect="fill"
                              size="sm"
                              className="h-8 rounded-[10px] px-3 text-[13px] font-medium"
                              disabled={busyId === connection.connectionId}
                              onClick={() => void handleRemove(connection)}
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
                              className="h-8 rounded-[10px] px-3 text-[13px] font-medium"
                              disabled={busyId === connection.connectionId}
                              onClick={() => setPendingRemoveId(null)}
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
                            onClick={() =>
                              setPendingRemoveId(connection.connectionId)
                            }
                            aria-label={`Remove connection with ${connection.displayName || connection.userId}`}
                            className="h-8 rounded-[10px] px-3 text-[13px] font-medium text-muted-foreground hover:text-destructive"
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

            <div className="space-y-4">
              <div className="flex w-full items-center gap-2">
                <div className="relative flex-1">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-muted-foreground/80">
                    <SearchIcon className="h-4.5 w-4.5" />
                  </span>
                  <Input
                    ref={searchInputRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search people by name"
                    aria-label="Search people"
                    data-voice-control-id="one-connect-search"
                    className="h-10 pl-11"
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
                      const dismiss = () => field.blur();
                      window.addEventListener("touchmove", dismiss, {
                        passive: true,
                        once: true,
                      });
                      field.addEventListener(
                        "blur",
                        () =>
                          window.removeEventListener("touchmove", dismiss),
                        { once: true },
                      );
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="none"
                  effect="fill"
                  size="sm"
                  disabled={loading || people.length === 0}
                  onClick={() => {
                    setIsSelectionMode((current) => !current);
                    setSelectedUserIds(new Set());
                  }}
                >
                  {isSelectionMode ? "Cancel selection" : "Select people"}
                </Button>
              </div>
              <SettingsGroup
                title="People"
                description={
                  isSelectionMode
                    ? (
                        <span id="connect-selection-limit">
                          Select up to {MAX_BULK_CONNECTION_REQUESTS} people to send connection requests.
                        </span>
                      )
                    : hasQuery
                    ? "Send a connection request to someone you know."
                    : "A few people on Hussh. Search by name to find someone specific."
                }
                separatorInset
              >
                {loading ? (
                  <SettingsRow
                    title="Finding people…"
                    density="compact"
                    disabled
                  />
                ) : error ? (
                  <SettingsRow
                    title="People are unavailable"
                    description={error}
                    density="compact"
                    tone="destructive"
                  />
                ) : people.length === 0 ? (
                  hasQuery ? (
                    <SettingsRow
                      title={`No one matches "${trimmedQuery}"`}
                      description="Check the spelling, or try their full name."
                      density="compact"
                      disabled
                    />
                  ) : (
                    <SettingsRow
                      title="No people yet"
                      description="Search by name to find someone on Hussh."
                      density="compact"
                      disabled
                    />
                  )
                ) : (
                  sortedPeople.map((person) => {
                    const cta = relationshipCta(person.relationship);
                    const title =
                      person.displayName || person.email || person.userId;
                    const description = getDirectoryPersonDescription(person);
                    const isSelected = selectedUserIds.has(person.userId);
                    const selectionLimitReached =
                      selectedUserIds.size >= MAX_BULK_CONNECTION_REQUESTS;
                    return (
                      <SettingsRow
                        key={person.userId}
                        icon={UserRound}
                        iconTone="blue"
                        title={title}
                        description={description}
                        density="compact"
                        trailing={
                          isSelectionMode ? (
                            <Checkbox
                              checked={isSelected}
                              disabled={
                                person.relationship !== "none" ||
                                (!isSelected && selectionLimitReached)
                              }
                              aria-describedby="connect-selection-limit"
                              onCheckedChange={(checked) => {
                                setSelectedUserIds((current) => {
                                  const next = new Set(current);
                                  if (checked) {
                                    if (next.size >= MAX_BULK_CONNECTION_REQUESTS) {
                                      return current;
                                    }
                                    next.add(person.userId);
                                  } else {
                                    next.delete(person.userId);
                                  }
                                  return next;
                                });
                              }}
                              aria-label={`Select ${title}`}
                            />
                          ) : person.relationship === "pending_outgoing" ? (
                            <Button
                              type="button"
                              variant="none"
                              effect="fill"
                              size="sm"
                              className="h-8 rounded-[10px] px-4 text-[13px] font-semibold"
                              disabled={busyId === person.userId}
                              onClick={() => void cancelConnectionRequest(person)}
                            >
                              {busyId === person.userId
                                ? "Cancelling…"
                                : "Cancel request"}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="none"
                              effect="fill"
                              size="sm"
                              className="h-8 rounded-[10px] px-4 text-[13px] font-semibold"
                              disabled={cta.disabled || busyId === person.userId}
                              onClick={() => void handleConnect(person)}
                            >
                              {busyId === person.userId ? "Sending…" : cta.label}
                            </Button>
                          )
                        }
                      />
                    );
                  })
                )}
                {people.length > 0 || currentPage > 1 ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--app-card-border-standard)] px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        id="connect-people-per-page-label"
                        className="text-xs text-muted-foreground"
                      >
                        Per page
                      </span>
                      <Select
                        value={String(pageSize)}
                        onValueChange={(value) => setPageSize(Number(value))}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label="People per page"
                          className="w-[78px]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAGE_SIZE_OPTIONS.map((size) => (
                            <SelectItem key={size} value={String(size)}>
                              {size}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="none"
                        effect="fill"
                        size="sm"
                        disabled={loading || currentPage <= 1}
                        onClick={() => goToPage(currentPage - 1)}
                      >
                        Previous
                      </Button>
                      {/* The directory reports only whether more exists, never
                          a total, so this names the page rather than claiming
                          "3 of 12" — a total the surface cannot stand behind. */}
                      <span
                        className="text-xs tabular-nums text-muted-foreground"
                        aria-live="polite"
                      >
                        Page {currentPage}
                      </span>
                      <Button
                        type="button"
                        variant="none"
                        effect="fill"
                        size="sm"
                        disabled={loading || !hasMore}
                        onClick={() => goToPage(currentPage + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                ) : null}
                {isSelectionMode && selectedUserIds.size > 0 && (
                  <div className="flex justify-center border-t border-[color:var(--app-card-border-standard)] px-3 py-4">
                    <Button
                      type="button"
                      variant="blue"
                      effect="fill"
                      disabled={isConnectingMultiple}
                      onClick={() => void handleConnectMultiple()}
                    >
                      {isConnectingMultiple
                        ? "Sending requests…"
                        : `Connect to Selected (${selectedUserIds.size}/${MAX_BULK_CONNECTION_REQUESTS})`}
                    </Button>
                  </div>
                )}
              </SettingsGroup>
                </div>
              </div>
            )}
          </div>
        </SurfaceStack>
      </AppPageContentRegion>

      <Dialog
        open={scopeDraft !== null}
        onOpenChange={(open) => {
          if (!open && busyId === null) setScopeDraft(null);
        }}
      >
        <DialogContent showCloseButton={false} className="gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Review connection capabilities</DialogTitle>
            <DialogDescription>
              A connection never shares information by itself. Choose only the
              capabilities you want to request or offer; the other person can
              approve a subset or decline them all.
            </DialogDescription>
          </DialogHeader>

          {scopeDraft ? (
            <div className="space-y-4">
              {scopeDraft.catalog.items.length > 0 ? (
                <SettingsGroup
                  title={`Request from ${scopeDraft.person.displayName || "this person"}`}
                  separatorInset
                >
                  {scopeDraft.catalog.items.map((item) => (
                    <SettingsRow
                      key={`request-${item.handle}`}
                      title={item.label}
                      description={item.description}
                      density="compact"
                      trailing={
                        <Checkbox
                          checked={scopeDraft.requestedHandles.includes(
                            item.handle,
                          )}
                          onCheckedChange={(checked) =>
                            toggleDraftHandle(
                              "requestedHandles",
                              item.handle,
                              checked === true,
                            )
                          }
                          aria-label={`Request ${item.label}`}
                        />
                      }
                    />
                  ))}
                </SettingsGroup>
              ) : null}
              {scopeDraft.catalog.offerableItems.length > 0 ? (
                <SettingsGroup title="Offer to them" separatorInset>
                  {scopeDraft.catalog.offerableItems.map((item) => (
                    <SettingsRow
                      key={`offer-${item.handle}`}
                      title={item.label}
                      description={item.description}
                      density="compact"
                      trailing={
                        <Checkbox
                          checked={scopeDraft.offeredHandles.includes(
                            item.handle,
                          )}
                          onCheckedChange={(checked) =>
                            toggleDraftHandle(
                              "offeredHandles",
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
              {scopeDraft.catalog.items.length === 0 &&
              scopeDraft.catalog.offerableItems.length === 0 ? (
                <SettingsGroup
                  title="No capabilities available yet"
                  description="You can still send a connection request. Capabilities appear here only when this relationship is eligible for them."
                  separatorInset
                >
                  <SettingsRow
                    title="Connection only"
                    description="This request does not grant access to any information or Kai debate."
                    density="compact"
                    disabled
                  />
                </SettingsGroup>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="none"
              effect="fade"
              disabled={busyId !== null}
              onClick={() => setScopeDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="blue"
              effect="fill"
              disabled={!scopeDraft || busyId === scopeDraft.person.userId}
              onClick={() => {
                if (!scopeDraft) return;
                void sendConnectionRequest(
                  scopeDraft.person,
                  scopeDraft.requestedHandles,
                  scopeDraft.offeredHandles,
                );
              }}
            >
              {scopeDraft && busyId === scopeDraft.person.userId
                ? "Sending…"
                : "Send request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={informationScopeDraft !== null}
        onOpenChange={(open) => {
          if (!open) setInformationScopeDraft(null);
        }}
      >
        <DialogContent className="gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Available information scopes</DialogTitle>
            <DialogDescription>
              {informationScopeDraft?.connection.displayName || "This person"} controls which
              scopes appear here. This is metadata only; requesting a scope still requires their
              explicit consent before an encrypted export can be created.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="search"
            value={informationScopeQuery}
            onChange={(event) => setInformationScopeQuery(event.target.value)}
            placeholder="Search available scopes"
            aria-label="Search available scopes"
          />
          <div className="max-h-[45vh] overflow-y-auto">
            {visibleInformationScopes && visibleInformationScopes.length > 0 ? (
              <SettingsGroup title="Discoverable scopes" separatorInset>
                {visibleInformationScopes.map((item) => (
                  <SettingsRow
                    key={item.scope}
                    title={item.label || item.scope}
                    description={item.scope}
                    density="compact"
                    disabled
                  />
                ))}
              </SettingsGroup>
            ) : (
              <SettingsGroup title="No matching scopes" separatorInset>
                <SettingsRow
                  title="Nothing is available for this search"
                  description="Private, internal, and empty scopes are never listed."
                  density="compact"
                  disabled
                />
              </SettingsGroup>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="none"
              effect="fade"
              onClick={() => setInformationScopeDraft(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPageShell>
  );
}
