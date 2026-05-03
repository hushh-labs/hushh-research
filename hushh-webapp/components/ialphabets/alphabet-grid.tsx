"use client";

import type { Letter, DraftPick } from "@/lib/stores/ialphabets-store";

const ALL_LETTERS: Letter[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") as Letter[];

interface AlphabetGridProps {
  picks: Partial<Record<Letter, DraftPick>>;
  onLetterClick: (letter: Letter) => void;
  isLocked: boolean;
}

export function AlphabetGrid({ picks, onLetterClick, isLocked }: AlphabetGridProps) {
  return (
    <div className="grid grid-cols-5 gap-2 sm:grid-cols-6 sm:gap-3">
      {ALL_LETTERS.map((letter) => {
        const pick = picks[letter];
        const filled = !!pick;

        return (
          <button
            key={letter}
            onClick={() => onLetterClick(letter)}
            disabled={isLocked}
            className={`group relative flex flex-col items-center justify-center rounded-xl border-2 p-3 transition-all
              ${
                filled
                  ? "border-primary/40 bg-primary/5 hover:border-primary"
                  : "border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-muted"
              }
              ${isLocked ? "cursor-default" : "cursor-pointer"}
            `}
          >
            {/* Letter */}
            <span
              className={`text-lg font-bold ${
                filled ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {letter}
            </span>

            {/* Ticker badge */}
            {filled ? (
              <span className="mt-1 truncate text-xs font-semibold text-foreground">
                {pick.ticker}
              </span>
            ) : (
              <span className="mt-1 text-[10px] text-muted-foreground/50">tap to pick</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
