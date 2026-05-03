"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import { getActiveSeason, listMyLeagues } from "@/lib/services/ialphabets-service";
import { ROUTES } from "@/lib/navigation/routes";
import { LeagueCard } from "@/components/ialphabets/league-card";
import { CountdownChip } from "@/components/ialphabets/countdown-chip";

export default function IalphabetsHomePage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [season, setSeason] = useState<any>(null);
  const [myLeagues, setMyLeagues] = useState<any[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newLeagueName, setNewLeagueName] = useState("");
  const [newLeaguePrivacy, setNewLeaguePrivacy] = useState<"private" | "public">("private");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (authLoading || !user) return;
    getActiveSeason()
      .then(setSeason)
      .catch(() => setSeason(null));
    listMyLeagues()
      .then((res: any) => setMyLeagues(res.leagues || []))
      .catch(() => setMyLeagues([]));
  }, [authLoading, user]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  async function handleCreateLeague() {
    if (!newLeagueName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const { createLeague } = await import("@/lib/services/ialphabets-service");
      const league: any = await createLeague({
        name: newLeagueName.trim(),
        privacy: newLeaguePrivacy,
      });
      router.push(`${ROUTES.IALPHABETS_DRAFT}/${league.id}`);
    } catch (e: any) {
      setError(e.message || "Failed to create league");
    } finally {
      setCreating(false);
    }
  }

  function handleJoin() {
    if (!joinCode.trim()) return;
    router.push(`${ROUTES.IALPHABETS_JOIN}/${joinCode.trim().toUpperCase()}`);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight">iAlphabets</h1>
        <p className="mt-2 text-lg text-muted-foreground">
          Draft 26 stocks. One per letter. Compete with friends.
        </p>
        {season && (
          <div className="mt-3 flex items-center justify-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">
              Season {season.slug}
            </span>
            <CountdownChip endsAt={season.ends_at} />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        {/* Create League */}
        <div className="rounded-xl border bg-card p-5">
          {!showCreate ? (
            <button
              onClick={() => setShowCreate(true)}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
            >
              Create a League
            </button>
          ) : (
            <div className="space-y-3">
              <input
                type="text"
                placeholder="League name..."
                value={newLeagueName}
                onChange={(e) => setNewLeagueName(e.target.value)}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                maxLength={100}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setNewLeaguePrivacy("private")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                    newLeaguePrivacy === "private"
                      ? "border-primary bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Private
                </button>
                <button
                  onClick={() => setNewLeaguePrivacy("public")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                    newLeaguePrivacy === "public"
                      ? "border-primary bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Public
                </button>
              </div>
              <button
                onClick={handleCreateLeague}
                disabled={creating || !newLeagueName.trim()}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create & Start Drafting"}
              </button>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}
        </div>

        {/* Join League */}
        <div className="rounded-xl border bg-card p-5">
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Enter invite code..."
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              className="w-full rounded-lg border bg-background px-3 py-2 text-center text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-primary"
              maxLength={6}
            />
            <button
              onClick={handleJoin}
              disabled={joinCode.length < 4}
              className="w-full rounded-lg border-2 border-primary px-4 py-2.5 text-sm font-semibold text-primary transition hover:bg-primary/10 disabled:opacity-50"
            >
              Join League
            </button>
          </div>
        </div>
      </div>

      {/* Browse public leagues */}
      <div className="mb-6 text-center">
        <button
          onClick={() => router.push(ROUTES.IALPHABETS_DISCOVER)}
          className="text-sm font-medium text-primary hover:underline"
        >
          Browse public leagues →
        </button>
      </div>

      {/* My Leagues */}
      {myLeagues.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold">My Leagues</h2>
          <div className="space-y-3">
            {myLeagues.map((league: any) => (
              <LeagueCard
                key={league.id}
                league={league}
                onClick={() =>
                  router.push(`${ROUTES.IALPHABETS_HOME}/leagues/${league.id}`)
                }
              />
            ))}
          </div>
        </div>
      )}

      {myLeagues.length === 0 && !authLoading && (
        <div className="rounded-xl border-2 border-dashed p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium">No leagues yet</p>
          <p className="mt-1 text-sm">Create one or join with a code to get started!</p>
        </div>
      )}
    </div>
  );
}
