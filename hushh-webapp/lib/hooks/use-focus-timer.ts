import { create } from "zustand";

type TimerMode = "pomodoro" | "shortBreak" | "longBreak";

interface FocusTimerState {
  isOpen: boolean;
  timeLeft: number;
  isRunning: boolean;
  mode: TimerMode;
  sessionsCompleted: number;
  setIsOpen: (isOpen: boolean) => void;
  toggleTimer: () => void;
  resetTimer: () => void;
  setMode: (mode: TimerMode) => void;
  tick: () => void;
}

const MODE_DURATIONS: Record<TimerMode, number> = {
  pomodoro: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60,
};

export const useFocusTimer = create<FocusTimerState>((set, get) => ({
  isOpen: false,
  timeLeft: MODE_DURATIONS.pomodoro,
  isRunning: false,
  mode: "pomodoro",
  sessionsCompleted: 0,
  setIsOpen: (isOpen) => set({ isOpen }),
  toggleTimer: () => set((state) => ({ isRunning: !state.isRunning })),
  resetTimer: () => set((state) => ({ timeLeft: MODE_DURATIONS[state.mode], isRunning: false })),
  setMode: (mode) => set({ mode, timeLeft: MODE_DURATIONS[mode], isRunning: false }),
  tick: () => {
    const { timeLeft, isRunning, mode, sessionsCompleted } = get();
    if (!isRunning) return;

    if (timeLeft > 0) {
      set({ timeLeft: timeLeft - 1 });
    } else {
      // Timer completed
      let nextMode: TimerMode = "pomodoro";
      let nextSessions = sessionsCompleted;

      if (mode === "pomodoro") {
        nextSessions += 1;
        // Every 4 sessions, take a long break
        nextMode = nextSessions % 4 === 0 ? "longBreak" : "shortBreak";
        
        // Play notification sound
        try {
          // Attempt to play a subtle chime using Web Audio API to avoid requiring static assets
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
          gain.gain.setValueAtTime(0, ctx.currentTime);
          gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.1);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 1.5);
        } catch (e) {
          console.error("Audio playback failed", e);
        }
      }

      set({
        isRunning: false,
        mode: nextMode,
        timeLeft: MODE_DURATIONS[nextMode],
        sessionsCompleted: nextSessions,
        isOpen: true, // Pop open the widget to show completion
      });
    }
  },
}));
