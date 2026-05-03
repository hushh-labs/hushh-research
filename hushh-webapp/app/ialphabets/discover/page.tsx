"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import { listPublicLeagues } from "@/lib/services/ialphabets-service";
import { ROUTES } from "@/lib/navigation/routes";
import { LeagueCard } from "@/components/ialphabets/league-card";

export default function DiscoverPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [leagues, setLeagues] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);

  async function loadLeagues(nextCursor?: string) {
    setLoading(true);
    try {
      const res: any = await listPublicLeagues(20, nextCursor);
      if (nextCursor) {
        setLeagues((prev) => [...prev, ...(res.leagues || [])]);
      } else {
        setLeagues(res.leagues || []);
      }
      setCursor(res.next_cursor || undefined);
      setHasMore(!!res.next_cursor);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLeagues();
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <button
        onClick={() => router.push(ROUTES.IALPHABETS_HOME)}
        className="mb-4 text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to iAlphabets
      </button>

      <h1 className="mb-2 text-2xl font-bold">Discover Public Leagues</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Join an open league and start competing
      </p>

      {leagues.length > 0 ? (
        <div className="space-y-3">
          {leagues.map((league: any) => (
            <LeagueCard
              key={league.id}
              league={league}
              onClick={() =>
                router.push(`${ROUTES.IALPHABETS_HOME}/leagues/${league.id}`)
              }
            />
          ))}
        </div>
      ) : !loading ? (
        <div className="rounded-xl border-2 border-dashed p-8 text-center text-muted-foreground">
          <p>No public leagues yet.</p>
          <p className="mt-1 text-sm">Be the first to create one!</p>
        </div>
      ) : null}

      {loading && (
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      )}

      {hasMore && !loading && (
        <div className="mt-4 text-center">
          <button
            onClick={() => loadLeagues(cursor)}
            className="text-sm font-medium text-primary hover:underline"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
