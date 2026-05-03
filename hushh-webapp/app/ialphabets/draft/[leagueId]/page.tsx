"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  ensureDraft,
  upsertPick,
  finalizeAlphabet,
  getMyAlphabet,
  searchTickersByLetter,
} from "@/lib/services/ialphabets-service";
import { useIalphabetsStore, type Letter, type DraftPick } from "@/lib/stores/ialphabets-store";
import { ROUTES } from "@/lib/navigation/routes";
import { AlphabetGrid } from "@/components/ialphabets/alphabet-grid";
import { LetterPickerSheet } from "@/components/ialphabets/letter-picker-sheet";
import { DraftFooter } from "@/components/ialphabets/draft-footer";

const ALL_LETTERS: Letter[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") as Letter[];

export default function DraftPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = use(params);
  const { user } = useAuth();
  const router = useRouter();
  const {
    draftPicks,
    openLetter,
    isFinalizing,
    setDraftPick,
    setOpenLetter,
    setIsFinalizing,
    clearDraft,
  } = useIalphabetsStore();

  const [alphabetId, setAlphabetId] = useState<string | null>(null);
  const [alphabetStatus, setAlphabetStatus] = useState<string>("drafting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tickerResults, setTickerResults] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!user) return;
    clearDraft();
    setLoading(true);

    ensureDraft(leagueId)
      .then((alpha: any) => {
        setAlphabetId(alpha.id);
        setAlphabetStatus(alpha.status);
        if (alpha.picks) {
          for (const p of alpha.picks) {
            setDraftPick({
              letter: p.letter as Letter,
              ticker: p.ticker,
              companyName: p.company_name || "",
            });
          }
        }
      })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [leagueId, user]);

  const handleLetterClick = useCallback(
    (letter: Letter) => {
      if (alphabetStatus !== "drafting") return;
      setOpenLetter(letter);
      setSearchQuery("");
      setTickerResults([]);
    },
    [alphabetStatus, setOpenLetter]
  );

  useEffect(() => {
    if (!openLetter) return;
    setSearching(true);
    searchTickersByLetter(openLetter, searchQuery, 25)
      .then((res: any) => setTickerResults(res.tickers || []))
      .catch(() => setTickerResults([]))
      .finally(() => setSearching(false));
  }, [openLetter, searchQuery]);

  async function handleSelectTicker(ticker: any) {
    if (!alphabetId || !openLetter) return;
    const pick: DraftPick = {
      letter: openLetter,
      ticker: ticker.ticker,
      companyName: ticker.title || "",
    };
    setDraftPick(pick);
    setOpenLetter(null);

    try {
      await upsertPick(leagueId, {
        letter: openLetter,
        ticker: ticker.ticker,
        company_name: ticker.title || "",
      });
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleFinalize() {
    if (isFinalizing) return;
    const pickedCount = Object.keys(draftPicks).length;
    if (pickedCount < 26) {
      setError(`Pick all 26 letters first (${pickedCount}/26)`);
      return;
    }

    setIsFinalizing(true);
    setError("");
    try {
      await finalizeAlphabet(leagueId);
      setAlphabetStatus("locked");
      router.push(`${ROUTES.IALPHABETS_HOME}/leagues/${leagueId}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsFinalizing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading draft...</div>
      </div>
    );
  }

  const pickedCount = Object.keys(draftPicks).length;
  const isLocked = alphabetStatus === "locked";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={() =>
            router.push(`${ROUTES.IALPHABETS_HOME}/leagues/${leagueId}`)
          }
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to League
        </button>
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
          {isLocked ? "Locked" : `${pickedCount}/26 picked`}
        </span>
      </div>

      <h1 className="mb-1 text-2xl font-bold">
        {isLocked ? "Your Alphabet" : "Draft Your Alphabet"}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {isLocked
          ? "Your picks are locked in. Track your performance on the leaderboard."
          : "Tap a letter to pick a stock. One ticker per letter, A through Z."}
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* The Grid */}
      <AlphabetGrid
        picks={draftPicks}
        onLetterClick={handleLetterClick}
        isLocked={isLocked}
      />

      {/* Footer */}
      {!isLocked && (
        <DraftFooter
          pickedCount={pickedCount}
          isFinalizing={isFinalizing}
          onFinalize={handleFinalize}
        />
      )}

      {/* Letter Picker Sheet */}
      <LetterPickerSheet
        letter={openLetter}
        isOpen={openLetter !== null}
        onClose={() => setOpenLetter(null)}
        tickers={tickerResults}
        searching={searching}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSelect={handleSelectTicker}
        currentPick={openLetter ? draftPicks[openLetter] : undefined}
      />
    </div>
  );
}
