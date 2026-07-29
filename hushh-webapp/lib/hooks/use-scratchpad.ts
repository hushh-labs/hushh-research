import { create } from "zustand";

interface ScratchpadState {
  content: string;
  isOpen: boolean;
  isInitialized: boolean;
  updateContent: (newContent: string) => void;
  toggleOpen: () => void;
  closeScratchpad: () => void;
}

export const useScratchpad = create<ScratchpadState>((set) => ({
  content: "",
  isOpen: false,
  isInitialized: true,
  updateContent: (newContent) => set({ content: newContent }),
  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen })),
  closeScratchpad: () => set({ isOpen: false }),
}));
