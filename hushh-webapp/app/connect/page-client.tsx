"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader, SectionHeader } from "@/components/app-ui/page-sections";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { useRequireAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import {
  ConnectionsService,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  const loadConnections = useCallback(async (): Promise<ConnectionSummaryEntry[]> => {
    if (!user) return [];
    try {
      const idToken = await user.getIdToken();
      return await ConnectionsService.listConnections({ idToken });
    } catch {
      /* non-fatal: connections section stays empty */
      return [];
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
    let cancelled = false;
    async function run() {
      if (!user) return;
      try {
        setLoading(true);
        setError(null);
        const idToken = await user.getIdToken();
        const page = await ConnectionsService.searchDirectory({ idToken, query: debouncedQuery, page: 1 });
        if (!cancelled) setPeople(page.items);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load people");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [user, debouncedQuery]);

  const handleConnect = useCallback(
    async (person: DirectoryPerson) => {
      if (!user) return;
      const cta = relationshipCta(person.relationship);
      if (cta.action === "respond") {
        router.push(buildConsentCenterHref("pending"));
        return;
      }
      if (cta.action !== "connect") return;
      try {
        setBusyId(person.userId);
        const idToken = await user.getIdToken();
        await ConnectionsService.sendRequest({ idToken, addresseeUserId: person.userId });
        setPeople((prev) =>
          prev.map((p) =>
            p.userId === person.userId ? { ...p, relationship: "pending_outgoing" } : p,
          ),
        );
        toast.success("Connection request sent");
      } catch (sendError) {
        toast.error(sendError instanceof Error ? sendError.message : "Failed to send request");
      } finally {
        setBusyId(null);
      }
    },
    [router, user],
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

  return (
    <AppPageShell
      as="main"
      width="narrow"
      className="pb-[calc(var(--app-bottom-inset)+var(--kai-command-fixed-ui,82px)+1.5rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/connect",
        marker: "native-route-connect",
        authState: user ? "authenticated" : "pending",
        dataState:
          error
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
          eyebrow="One / Connect"
          title="Connect"
          description="Find people on Hushh and send a connection request."
          icon={UserPlus}
          accent="neutral"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <section className="space-y-3" aria-labelledby="my-connections-heading">
            <SectionHeader
              id="my-connections-heading"
              title={`My connections (${connections.length})`}
              accent="neutral"
            />
            {connections.length === 0 ? (
              <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
                You have no connections yet.
              </SurfaceInset>
            ) : (
              <SurfaceInset className="p-0">
                <ul className="divide-y divide-border/70">
                  {connections.map((connection) => (
                    <li
                      key={connection.connectionId}
                      className="flex min-h-14 items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">
                        {connection.displayName || connection.userId}
                      </span>
                      {pendingRemoveId === connection.connectionId ? (
                        <span className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            disabled={busyId === connection.connectionId}
                            onClick={() => void handleRemove(connection)}
                            className="inline-flex min-h-9 items-center justify-center rounded-full bg-destructive px-4 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                          >
                            {busyId === connection.connectionId
                              ? "Removing…"
                              : "Confirm"}
                          </button>
                          <button
                            type="button"
                            disabled={busyId === connection.connectionId}
                            onClick={() => setPendingRemoveId(null)}
                            className="inline-flex min-h-9 items-center justify-center rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingRemoveId(connection.connectionId)}
                          aria-label={`Remove connection with ${connection.displayName || connection.userId}`}
                          className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </SurfaceInset>
            )}
          </section>

          <section className="space-y-3" aria-labelledby="people-heading">
            <SectionHeader id="people-heading" title="People" accent="neutral" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people by name or email"
              aria-label="Search people"
              className="min-h-11 w-full rounded-[var(--app-control-radius)] border border-border bg-background px-4 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            {loading ? (
              <p className="text-sm text-muted-foreground">Finding people…</p>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {!loading && !error && people.length === 0 ? (
              <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
                No people found.
              </SurfaceInset>
            ) : null}
            {people.length > 0 ? (
              <SurfaceInset className="p-0">
                <ul className="divide-y divide-border/70">
                  {people.map((person) => {
                    const cta = relationshipCta(person.relationship);
                    return (
                      <li
                        key={person.userId}
                        className="flex min-h-14 items-center justify-between gap-3 px-4 py-3"
                      >
                        <span className="min-w-0 truncate text-sm font-medium text-foreground">
                          {person.displayName || person.email || person.userId}
                        </span>
                        <button
                          type="button"
                          disabled={cta.disabled || busyId === person.userId}
                          onClick={() => void handleConnect(person)}
                          className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-full bg-foreground px-4 text-xs font-medium text-background transition-opacity disabled:opacity-50"
                        >
                          {busyId === person.userId ? "Sending…" : cta.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </SurfaceInset>
            ) : null}
          </section>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
