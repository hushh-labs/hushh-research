"use client";

import { useEffect, useRef } from "react";
import type { Letter, DraftPick } from "@/lib/stores/ialphabets-store";

interface LetterPickerSheetProps {
  letter: Letter | null;
  isOpen: boolean;
  onClose: () => void;
  tickers: any[];
  searching: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelect: (ticker: any) => void;
  currentPick?: DraftPick;
}

export function LetterPickerSheet({
  letter,
  isOpen,
  onClose,
  tickers,
  searching,
  searchQuery,
  onSearchChange,
  onSelect,
  currentPick,
}: LetterPickerSheetProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  if (!isOpen || !letter) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-lg animate-in slide-in-from-bottom duration-200">
        <div className="rounded-t-2xl border bg-card shadow-2xl">
          {/* Handle */}
          <div className="flex justify-center pt-3">
            <div className="h-1 w-8 rounded-full bg-muted-foreground/30" />
          </div>

          {/* Header */}
          <div className="px-5 pb-3 pt-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">
                Pick a stock for{" "}
                <span className="text-primary">{letter}</span>
              </h2>
              <button
                onClick={onClose}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
              >
                ✕
              </button>
            </div>
            {currentPick && (
              <p className="mt-1 text-xs text-muted-foreground">
                Current: {currentPick.ticker} — {currentPick.companyName}
              </p>
            )}
          </div>

          {/* Search */}
          <div className="px-5 pb-3">
            <input
              ref={inputRef}
              type="text"
              placeholder={`Search ${letter}... tickers`}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* Results */}
          <div className="max-h-[50vh] overflow-y-auto px-5 pb-5">
            {searching ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Searching...
              </div>
            ) : tickers.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No tickers found for &quot;{letter}&quot;
                {searchQuery ? ` matching "${searchQuery}"` : ""}
              </div>
            ) : (
              <div className="space-y-1">
                {tickers.map((t: any) => (
                  <button
                    key={t.ticker}
                    onClick={() => onSelect(t)}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition hover:bg-muted"
                  >
                    <div>
                      <span className="font-semibold">{t.ticker}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t.title}
                      </span>
                    </div>
                    {t.exchange && (
                      <span className="text-[10px] text-muted-foreground">
                        {t.exchange}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
