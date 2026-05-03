"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  getInvitePreview,
  redeemInvite,
} from "@/lib/services/ialphabets-service";
import { ROUTES } from "@/lib/navigation/routes";

export default function JoinLeaguePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getInvitePreview(code)
      .then(setPreview)
      .catch(() => setError("Invalid or expired invite code"))
      .finally(() => setLoading(false));
  }, [code]);

  async function handleJoin() {
    if (!user) {
      router.push(`${ROUTES.LOGIN}?redirect=/ialphabets/join/${code}`);
      return;
    }
    setJoining(true);
    setError("");
    try {
      const result: any = await redeemInvite(code);
      router.push(`${ROUTES.IALPHABETS_DRAFT}/${result.league_id}`);
    } catch (e: any) {
      setError(e.message || "Failed to join league");
    } finally {
      setJoining(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading invite...</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 text-center shadow-lg">
        {preview ? (
          <>
            <div className="mb-2 text-4xl">🏆</div>
            <h1 className="text-xl font-bold">
              Join {preview.league_name || "League"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {preview.member_count}/{preview.max_members} members ·{" "}
              {preview.privacy === "public" ? "Public" : "Private"}
            </p>

            <div className="mt-6">
              <button
                onClick={handleJoin}
                disabled={joining}
                className="w-full rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {joining
                  ? "Joining..."
                  : user
                    ? "Join & Start Drafting"
                    : "Sign in to Join"}
              </button>
            </div>

            {error && (
              <p className="mt-3 text-sm text-destructive">{error}</p>
            )}
          </>
        ) : (
          <div>
            <h1 className="text-xl font-bold">Invalid Invite</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {error || "This invite code is invalid or has expired."}
            </p>
            <button
              onClick={() => router.push(ROUTES.IALPHABETS_HOME)}
              className="mt-4 text-sm font-medium text-primary hover:underline"
            >
              Go to iAlphabets →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
