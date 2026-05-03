/**
 * iAlphabets Zustand store — in-memory session state for the trading game.
 *
 * No persistence (mirrors kai-session-store pattern).
 * On refresh, user re-enters from the home page.
 */

import { create } from "zustand";

export type Letter =
  | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I"
  | "J" | "K" | "L" | "M" | "N" | "O" | "P" | "Q" | "R"
  | "S" | "T" | "U" | "V" | "W" | "X" | "Y" | "Z";

export interface DraftPick {
  letter: Letter;
  ticker: string;
  companyName: string;
}

interface IalphabetsState {
  activeLeagueId: string | null;
  draftPicks: Partial<Record<Letter, DraftPick>>;
  openLetter: Letter | null;
  isFinalizing: boolean;

  setActiveLeague: (id: string | null) => void;
  setDraftPick: (pick: DraftPick) => void;
  removeDraftPick: (letter: Letter) => void;
  clearDraft: () => void;
  setOpenLetter: (letter: Letter | null) => void;
  setIsFinalizing: (v: boolean) => void;
}

export const useIalphabetsStore = create<IalphabetsState>((set) => ({
  activeLeagueId: null,
  draftPicks: {},
  openLetter: null,
  isFinalizing: false,

  setActiveLeague: (id) => set({ activeLeagueId: id }),

  setDraftPick: (pick) =>
    set((state) => ({
      draftPicks: { ...state.draftPicks, [pick.letter]: pick },
    })),

  removeDraftPick: (letter) =>
    set((state) => {
      const next = { ...state.draftPicks };
      delete next[letter];
      return { draftPicks: next };
    }),

  clearDraft: () => set({ draftPicks: {}, openLetter: null, isFinalizing: false }),

  setOpenLetter: (letter) => set({ openLetter: letter }),

  setIsFinalizing: (v) => set({ isFinalizing: v }),
}));
