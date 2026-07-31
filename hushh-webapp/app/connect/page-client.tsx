"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search as SearchIcon, UserRound, Users } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SurfaceStack } from "@/components/app-ui/surfaces";
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
import { useRequireAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button } from "@/lib/morphy-ux/button";
import {
  ConnectionsService,
  type ConnectionScopeCatalog,
  type ConnectionSummaryEntry,
  type DirectoryPerson,
} from "@/lib/services/connections-service";
import { relationshipCta } from "@/lib/connections/relationship-label";

export default function ConnectPageClient() {
  const { user } = useRequireAuth();
  const router = useRouter();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);

  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [connections, setConnections] = useState<ConnectionSummaryEntry[]>([]);
  const [outgoingRequestIds, setOutgoingRequestIds] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [scopeDraft, setScopeDraft] = useState<{
    person: DirectoryPerson;
    catalog: ConnectionScopeCatalog;
    requestedHandles: string[];
    offeredHandles: string[];
  } | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user) return;
      try {
        setHasMore(false);
        setCurrentPage(1);
        setLoading(true);
        setError(null);
        const idToken = await user.getIdToken();
        const page = await ConnectionsService.searchDirectory({
          idToken,
          query: debouncedQuery,
          page: 1,
        });
        if (!cancelled) {
          setPeople(page.items);
          setHasMore(page.hasMore);
          setCurrentPage(page.page);
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
  }, [user, debouncedQuery]);

  const loadMorePeople = useCallback(async () => {
    if (!user || loadingMore || !hasMore) return;
    try {
      setLoadingMore(true);
      const idToken = await user.getIdToken();
      const page = await ConnectionsService.searchDirectory({
        idToken,
        query: debouncedQuery,
        page: currentPage + 1,
      });
      setPeople((current) => {
        const existing = new Set(current.map((person) => person.userId));
        return [
          ...current,
          ...page.items.filter((person) => !existing.has(person.userId)),
        ];
      });
      setHasMore(page.hasMore);
      setCurrentPage(page.page);
    } catch (loadError) {
      toast.error(
        loadError instanceof Error ? loadError.message : "Failed to load more people",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [currentPage, debouncedQuery, hasMore, loadingMore, user]);

  const sendConnectionRequest = useCallback(
    async (
      person: DirectoryPerson,
      requestedScopeHandles: string[] = [],
      offeredScopeHandles: string[] = [],
    ) => {
      if (!user) return;
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
      } catch (sendError) {
        toast.error(
          sendError instanceof Error
            ? sendError.message
            : "Failed to send request",
        );
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
    [sendConnectionRequest, user],
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

  const cancelConnectionRequest = useCallback(
    async (person: DirectoryPerson) => {
      if (!user) return;
      const requestId = outgoingRequestIds[person.userId];
      if (!requestId) {
        toast.error("This request is still loading. Try again in a moment.");
        return;
      }
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

  return (
    <AppPageShell
      as="main"
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
        <PageHeader
          title="Connect"
          description="Find people on Hussh and send a connection request."
          accent="neutral"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
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
                connections.map((connection) => (
                  <SettingsRow
                    key={connection.connectionId}
                    icon={Users}
                    iconTone="blue"
                    title={connection.displayName || connection.userId}
                    density="compact"
                    trailing={
                      pendingRemoveId === connection.connectionId ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="destructive"
                            effect="fill"
                            size="sm"
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
                            disabled={busyId === connection.connectionId}
                            onClick={() => setPendingRemoveId(null)}
                          >
                            Cancel
                          </Button>
                        </span>
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
                          className="text-muted-foreground hover:text-destructive"
                        >
                          Remove
                        </Button>
                      )
                    }
                  />
                ))
              )}
            </SettingsGroup>

            <div className="space-y-4">
              <div className="relative w-full">
                <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-muted-foreground/80">
                  <SearchIcon className="h-4.5 w-4.5" />
                </span>
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search people by name"
                  aria-label="Search people"
                  className="h-10 pl-11"
                />
              </div>
              <SettingsGroup
                title="People"
                description="Find people on Hushh and send a connection request."
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
                  <SettingsRow
                    title="No people found"
                    density="compact"
                    disabled
                  />
                ) : (
                  people.map((person) => {
                    const cta = relationshipCta(person.relationship);
                    const title =
                      person.displayName || person.email || person.userId;
                    const description =
                      person.displayName && person.email
                        ? person.email
                        : undefined;
                    return (
                      <SettingsRow
                        key={person.userId}
                        icon={UserRound}
                        iconTone="blue"
                        title={title}
                        description={description}
                        density="compact"
                        trailing={
                          person.relationship === "pending_outgoing" ? (
                            <Button
                              type="button"
                              variant="none"
                              effect="fill"
                              size="sm"
                              disabled={
                                busyId === person.userId ||
                                !outgoingRequestIds[person.userId]
                              }
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
                {hasMore ? (
                  <div className="flex justify-center px-3 py-2">
                    <Button
                      type="button"
                      variant="none"
                      effect="fill"
                      size="sm"
                      disabled={loadingMore}
                      onClick={() => void loadMorePeople()}
                    >
                      {loadingMore ? "Loading…" : "Load more people"}
                    </Button>
                  </div>
                ) : null}
              </SettingsGroup>
            </div>
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
    </AppPageShell>
  );
}
