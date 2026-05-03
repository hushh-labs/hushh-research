"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  getLeague,
  createInvite,
  getLeaderboard,
} from "@/lib/services/ialphabets-service";
import { ROUTES } from "@/lib/navigation/routes";
import { LeagueLeaderboard } from "@/components/ialphabets/league-leaderboard";
import { CountdownChip } from "@/components/ialphabets/countdown-chip";
import { InviteLinkButton } from "@/components/ialphabets/invite-link-button";

export default function LeagueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: leagueId } = use(params);
  const { user } = useAuth();
  const router = useRouter();
  const [league, setLeague] = useState<any>(null);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getLeague(leagueId).then(setLeague),
      getLeaderboard(leagueId).then((res: any) =>
        setLeaderboard(res.rows || [])
      ),
    ])
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [leagueId, user]);

  async function handleCopyInvite() {
    if (inviteCode) return inviteCode;
    try {
      const inv: any = await createInvite({ league_id: leagueId, kind: "league" });
      setInviteCode(inv.code);
      return inv.code;
    } catch (e) {
      console.error(e);
      return league?.invite_code || "";
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading league...</div>
      </div>
    );
  }

  if (!league) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">League not found</p>
      </div>
    );
  }

  const hasAlphabet = league.my_alphabet?.status === "locked";
  const isDrafting = league.my_alphabet?.status === "drafting";

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* Back */}
      <button
        onClick={() => router.push(ROUTES.IALPHABETS_HOME)}
        className="mb-4 text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to iAlphabets
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{league.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {league.member_count} member{league.member_count !== 1 ? "s" : ""} ·{" "}
              {league.privacy === "public" ? "Public" : "Private"} ·{" "}
              {league.status}
            </p>
          </div>
          <InviteLinkButton
            code={inviteCode || league.invite_code}
            onGetCode={handleCopyInvite}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="mb-6 flex gap-3">
        {!league.my_alphabet && (
          <button
            onClick={() =>
              router.push(`${ROUTES.IALPHABETS_DRAFT}/${leagueId}`)
            }
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Start Drafting
          </button>
        )}
        {isDrafting && (
          <button
            onClick={() =>
              router.push(`${ROUTES.IALPHABETS_DRAFT}/${leagueId}`)
            }
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Continue Draft
          </button>
        )}
        {hasAlphabet && (
          <button
            onClick={() =>
              router.push(`${ROUTES.IALPHABETS_DRAFT}/${leagueId}`)
            }
            className="rounded-lg border px-5 py-2.5 text-sm font-medium transition hover:bg-muted"
          >
            View My Alphabet
          </button>
        )}
      </div>

      {/* Leaderboard */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">Leaderboard</h2>
        {leaderboard.length > 0 ? (
          <LeagueLeaderboard rows={leaderboard} currentUserId={user?.uid} />
        ) : (
          <div className="rounded-xl border-2 border-dashed p-6 text-center text-muted-foreground">
            <p>No finalized alphabets yet.</p>
            <p className="mt-1 text-sm">
              Draft and finalize your alphabet to appear here!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
