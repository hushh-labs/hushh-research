"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/hooks/use-auth";
import { AppPageShell, AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { ChevronRight, UsersThreeIcon } from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import { ConnectionsService, ConnectionsServiceRequestError, type MutualConnectionsPage } from "@/lib/services/connections-service";
import { buildPersonProfileRoute } from "@/lib/navigation/routes";
import { connectPersonName } from "@/lib/connections/person-label";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { readConnectListMemory, saveConnectListMemory, connectListScrollTop, restoreConnectListScroll } from "@/lib/connect/connect-list-memory";

type Snapshot = { result: MutualConnectionsPage; scrollTop: number };

/** The list remains a list if the graph changes while a profile is open. */
export function MutualConnectionsList({ personRef, href }: { personRef: string; href: string }) {
  const { user, userId } = useRequireAuth();
  const router = useRouter();
  const memoryKey = `mutuals:${personRef}`;
  const [saved] = useState(() => readConnectListMemory<Snapshot>(userId, memoryKey));
  const [result, setResult] = useState<MutualConnectionsPage | null>(saved?.result ?? null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [nextPage, setNextPage] = useState(saved?.result.page ?? 1);
  const requestRef = useRef(0);
  const restoredRef = useRef(false);
  const revalidateRetainedPagesRef = useRef(Boolean(saved));
  const displayedPerson = result ? connectPersonName(result.person) : null;

  useEffect(() => {
    if (!saved || restoredRef.current) return;
    restoredRef.current = true;
    return restoreConnectListScroll(saved.scrollTop);
  }, [saved]);

  useEffect(() => subscribeToConnectionGraphChanges((event) => {
    if (event.userId === userId) {
      revalidateRetainedPagesRef.current = true;
      setRevision((value) => value + 1);
    }
  }), [userId]);

  useEffect(() => {
    if (!user || !userId) return;
    const request = ++requestRef.current;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        // Revalidate every retained page on return, so a disconnection in an
        // earlier page is reflected without throwing away navigation memory.
        const first = revalidateRetainedPagesRef.current ? 1 : nextPage;
        const pages: MutualConnectionsPage[] = [];
        for (let page = first; page <= nextPage; page++) {
          const value = await ConnectionsService.listMutualConnections({ idToken, personRef, page, signal: controller.signal });
          pages.push(value);
          if (!value.hasMore) break;
        }
        if (controller.signal.aborted || request !== requestRef.current) return;
        revalidateRetainedPagesRef.current = false;
        const last = pages[pages.length - 1];
        if (!last) return;
        setResult((previous) => ({ ...last, items: [...new Map([
          ...(first > 1 ? previous?.items ?? [] : []), ...pages.flatMap((value) => value.items),
        ].map((person) => [person.publicPersonRef, person])).values()] }));
      } catch (failure) {
        if (!controller.signal.aborted && request === requestRef.current) {
          if (failure instanceof ConnectionsServiceRequestError && [401, 403, 404].includes(failure.status)) {
            saveConnectListMemory(userId, memoryKey, null);
            setResult(null);
          }
          setError("Could not load mutual connections. Please try again.");
        }
      } finally {
        if (!controller.signal.aborted && request === requestRef.current) setBusy(false);
      }
    })();
    return () => { controller.abort(); };
  }, [user, userId, personRef, memoryKey, nextPage, revision]);

  return (
    <AppPageShell
      as="main"
      width="standard"
      fitContent
      data-connect-type-scale="page"
      data-testid="mutual-connections-list"
      style={{ maxWidth: "70rem" }}
    >
      <AppPageContentRegion className="mx-auto w-full max-w-[68rem] space-y-5 sm:space-y-6">
        <section className="overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-sm sm:rounded-3xl">
          <header className="flex flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6 md:flex-row md:items-center md:justify-between md:gap-8 md:px-8 md:py-8">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary">
                <UsersThreeIcon className="size-4" aria-hidden="true" />
                <span>People in common</span>
              </div>
              <h1 className="mt-4 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                {result ? `${result.totalCount} mutual ${result.totalCount === 1 ? "connection" : "connections"}` : "Mutual connections"}
              </h1>
              <p className="mt-2 max-w-2xl text-base leading-6 text-muted-foreground">
                {displayedPerson
                  ? `You and ${displayedPerson} are both connected to these people.`
                  : "People connected to both of you."}
              </p>
              {result?.hasMore ? (
                <p className="mt-3 text-sm font-medium text-muted-foreground" role="status">
                  Showing {result.items.length} of {result.totalCount}
                </p>
              ) : null}
              {result && !result.hasMore && result.items.length < result.totalCount ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Some mutual connections are unavailable to view.
                </p>
              ) : null}
            </div>

            {result ? (
              <div className="flex shrink-0 items-center gap-3 rounded-2xl border border-border/70 bg-muted/40 px-4 py-3 md:min-w-56">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-background text-primary shadow-sm ring-1 ring-border/70">
                  <UsersThreeIcon className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">Shared network</span>
                  <span className="mt-0.5 block truncate text-sm font-semibold">With {displayedPerson}</span>
                </span>
              </div>
            ) : null}
          </header>

          <div className="px-3 pb-3 sm:px-5 sm:pb-5 md:px-7 md:pb-7">
            {busy || result ? (
              <>
                <div className="mb-3 flex min-h-8 items-center justify-between gap-3 px-1 sm:px-2">
                  <h2 className="text-base font-semibold sm:text-lg">People you both know</h2>
                  {result && !busy ? <span className="text-sm text-muted-foreground">{result.items.length} shown</span> : null}
                </div>

                <div className="overflow-hidden rounded-2xl border border-border/80 bg-background" aria-busy={busy}>
                  {result?.items.length ? (
                    <ul className="divide-y divide-border/70">
                      {result.items.map((person) => {
                        const name = connectPersonName(person);
                        return (
                          <li key={person.publicPersonRef}>
                            <button
                              type="button"
                              aria-label={`Open ${name}'s profile`}
                              onClick={() => {
                                saveConnectListMemory(userId, memoryKey, { result, scrollTop: connectListScrollTop() });
                                router.push(buildPersonProfileRoute(person.publicPersonRef, { from: href }));
                              }}
                              className="group flex min-h-[76px] w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary active:bg-muted sm:min-h-[84px] sm:gap-4 sm:px-5 sm:py-4 motion-reduce:transition-none"
                            >
                              <ConnectionPersonAvatar
                                size="list"
                                className="!size-11 sm:!size-12"
                                label={name}
                                photoUrl={person.photoUrl}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block break-words text-base font-semibold leading-6 sm:text-lg">
                                  {name}
                                </span>
                              </span>
                              <span className="hidden shrink-0 text-sm font-medium text-muted-foreground sm:inline">
                                View profile
                              </span>
                              <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  {busy ? (
                    <div className="space-y-0 divide-y divide-border/70" role="status" aria-label="Loading mutual connections">
                      <span className="sr-only">Loading mutual connections…</span>
                      {[0, 1, 2].map((item) => (
                        <div key={item} className="flex min-h-[76px] items-center gap-3 px-4 py-3 sm:min-h-[84px] sm:gap-4 sm:px-5 sm:py-4">
                          <span className="size-11 shrink-0 animate-pulse rounded-full bg-muted sm:size-12" />
                          <span className="min-w-0 flex-1 space-y-2">
                            <span className="block h-4 w-2/5 animate-pulse rounded bg-muted" />
                            <span className="block h-3 w-1/4 animate-pulse rounded bg-muted/70" />
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {!busy && !error && result?.items.length === 0 ? (
                    <div className="px-5 py-10 text-center sm:px-8">
                      <span className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                        <UsersThreeIcon className="size-5" aria-hidden="true" />
                      </span>
                      <p className="mt-4 text-base font-semibold">No profiles to show</p>
                      <p className="mx-auto mt-1 max-w-md text-sm leading-5 text-muted-foreground" role="status">
                        No mutual connection profiles are available to view right now.
                      </p>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </section>

        {error ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-destructive/25 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5" role="alert">
            <p className="text-sm leading-5">{error}</p>
            <Button variant="none" size="sm" className="min-h-11 shrink-0 rounded-full px-5" onClick={() => setRevision((value) => value + 1)} disabled={busy}>
              Try again
            </Button>
          </div>
        ) : null}

        {result?.hasMore && !error ? (
          <div className="flex justify-center">
            <Button variant="none" size="standard" className="min-h-12 rounded-full px-6" disabled={busy} onClick={() => setNextPage(result.page + 1)}>
              Load more mutual connections
            </Button>
          </div>
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
