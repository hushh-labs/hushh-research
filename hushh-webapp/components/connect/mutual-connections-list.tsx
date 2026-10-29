"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/hooks/use-auth";
import { AppPageShell, AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ConnectPersonRow } from "@/components/connect/connect-person-row";
import { SectionLabel } from "@/components/app-ui/typography";
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
    <AppPageShell as="main" width="reading" fitContent data-connect-type-scale="page" data-testid="mutual-connections-list">
      <AppPageContentRegion className="space-y-4">
        <div>
          <SectionLabel>{result ? `${result.totalCount} ${result.totalCount === 1 ? "mutual connection" : "mutual connections"}` : "People in common"}</SectionLabel>
          <p className="mt-2 text-sm text-muted-foreground">People you and {result ? connectPersonName(result.person) : "this person"} are both connected to.</p>
          {result?.hasMore ? <p className="mt-1 text-sm text-muted-foreground" role="status">{result.items.length} of {result.totalCount} shown</p> : null}
          {result && !result.hasMore && result.items.length < result.totalCount ? <p className="mt-1 text-sm text-muted-foreground">Some mutual connections are unavailable to view.</p> : null}
        </div>
        <div aria-busy={busy}>
          {result?.items.map((person) => {
            const name = connectPersonName(person);
            return <ConnectPersonRow key={person.publicPersonRef} title={name}
              leading={<ConnectionPersonAvatar size="compact" className="!size-9" label={name} photoUrl={person.photoUrl} />}
              openLabel={`Open ${name}'s profile`}
              onOpen={() => {
                saveConnectListMemory(userId, memoryKey, { result, scrollTop: connectListScrollTop() });
                router.push(buildPersonProfileRoute(person.publicPersonRef, { from: href }));
              }} />;
          })}
        </div>
        {busy ? <p role="status" className="text-sm text-muted-foreground">Loading mutual connections…</p> : null}
        {!busy && !error && result?.items.length === 0 ? <p role="status" className="text-sm text-muted-foreground">No mutual connections are available to view right now.</p> : null}
        {error ? <div role="alert"><p>{error}</p><Button variant="none" onClick={() => setRevision((value) => value + 1)} disabled={busy}>Try again</Button></div> : null}
        {result?.hasMore && !error ? <Button variant="none" disabled={busy} onClick={() => setNextPage(result.page + 1)}>Load more mutual connections</Button> : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
