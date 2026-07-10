"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      setConnections(await ConnectionsService.listConnections({ idToken }));
    } catch {
      /* non-fatal: connections section stays empty */
    }
  }, [user]);

  useEffect(() => {
    void loadConnections();
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

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">Connect</h1>
        <p className="text-sm text-muted-foreground">Find people on Hushh and send a connection request.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          My connections ({connections.length})
        </h2>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no connections yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connections.map((c) => (
              <li key={c.connectionId} className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                <span className="text-sm font-medium text-foreground">{c.displayName || c.userId}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">People</h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people by name or email"
          aria-label="Search people"
          className="min-h-11 w-full rounded-full border border-border bg-background px-4 text-sm text-foreground"
        />
        {loading ? <p className="text-sm text-muted-foreground">Searching…</p> : null}
        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        {!loading && !error && people.length === 0 ? (
          <p className="text-sm text-muted-foreground">No people found.</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {people.map((person) => {
            const cta = relationshipCta(person.relationship);
            return (
              <li key={person.userId} className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                <span className="text-sm font-medium text-foreground">{person.displayName || person.email || person.userId}</span>
                <button
                  type="button"
                  disabled={cta.disabled || busyId === person.userId}
                  onClick={() => void handleConnect(person)}
                  className="inline-flex min-h-9 items-center justify-center rounded-full bg-foreground px-4 text-xs font-medium text-background disabled:opacity-50"
                >
                  {busyId === person.userId ? "Sending…" : cta.label}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
