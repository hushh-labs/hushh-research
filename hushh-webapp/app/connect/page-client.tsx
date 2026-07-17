"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Users, Search as SearchIcon } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { useRequireAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { Button } from "@/lib/morphy-ux/button";
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
          eyebrow="One"
          title="Connect"
          description="Find people on Hussh and send a connection request."
          icon={Users}
          accent="neutral"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div className="space-y-[var(--app-section-gap)]">
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
                          {busyId === connection.connectionId ? "Removing…" : "Confirm"}
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
                        onClick={() => setPendingRemoveId(connection.connectionId)}
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
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search people by name or email"
                aria-label="Search people"
                className="min-h-12 w-full rounded-2xl border border-border/85 bg-white/70 dark:bg-black/20 pl-11 pr-4 text-sm text-foreground outline-none backdrop-blur-md transition-all placeholder:text-muted-foreground/60 focus:border-accent focus:ring-4 focus:ring-accent/10 shadow-sm"
              />
            </div>
            <SettingsGroup
              title="People"
              description="Find people on Hushh and send a connection request."
              separatorInset
            >
              {loading ? (
                <SettingsRow title="Finding people…" density="compact" disabled />
              ) : error ? (
                <SettingsRow
                  title="People are unavailable"
                  description={error}
                  density="compact"
                  tone="destructive"
                />
              ) : people.length === 0 ? (
                <SettingsRow title="No people found" density="compact" disabled />
              ) : (
                people.map((person) => {
                  const cta = relationshipCta(person.relationship);
                  const title = person.displayName || person.email || person.userId;
                  const description = person.displayName && person.email ? person.email : undefined;
                  return (
                    <SettingsRow
                      key={person.userId}
                      title={title}
                      description={description}
                      density="compact"
                      trailing={
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
                      }
                    />
                  );
                })
              )}
            </SettingsGroup>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
