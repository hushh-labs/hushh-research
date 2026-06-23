import { describe, expect, it, beforeEach } from "vitest";
import { useFocusTimer } from "@/lib/hooks/use-focus-timer";

const POMODORO = 25 * 60;
const SHORT_BREAK = 5 * 60;
const LONG_BREAK = 15 * 60;

function get() {
  return useFocusTimer.getState();
}

function resetStore() {
  useFocusTimer.setState({
    isOpen: false,
    timeLeft: POMODORO,
    isRunning: false,
    mode: "pomodoro",
    sessionsCompleted: 0,
  });
}

beforeEach(() => {
  resetStore();
});

describe("useFocusTimer initial state", () => {
  it("has documented defaults", () => {
    const state = get();

    expect(state.isOpen).toBe(false);
    expect(state.mode).toBe("pomodoro");
    expect(state.timeLeft).toBe(POMODORO);
    expect(state.isRunning).toBe(false);
    expect(state.sessionsCompleted).toBe(0);
  });
});

describe("setIsOpen", () => {
  it("updates only isOpen", () => {
    get().setIsOpen(true);

    expect(get().isOpen).toBe(true);
    expect(get().mode).toBe("pomodoro");
  });
});

describe("toggleTimer", () => {
  it("toggles isRunning", () => {
    get().toggleTimer();
    expect(get().isRunning).toBe(true);

    get().toggleTimer();
    expect(get().isRunning).toBe(false);
  });
});

describe("resetTimer", () => {
  it("restores pomodoro duration", () => {
    useFocusTimer.setState({
      timeLeft: 100,
      isRunning: true,
    });

    get().resetTimer();

    expect(get().timeLeft).toBe(POMODORO);
    expect(get().isRunning).toBe(false);
  });

  it("restores short break duration", () => {
    useFocusTimer.setState({
      mode: "shortBreak",
      timeLeft: 10,
    });

    get().resetTimer();

    expect(get().timeLeft).toBe(SHORT_BREAK);
  });

  it("restores long break duration", () => {
    useFocusTimer.setState({
      mode: "longBreak",
      timeLeft: 10,
    });

    get().resetTimer();

    expect(get().timeLeft).toBe(LONG_BREAK);
  });
});

describe("setMode", () => {
  it("changes mode and duration", () => {
    get().setMode("shortBreak");

    expect(get().mode).toBe("shortBreak");
    expect(get().timeLeft).toBe(SHORT_BREAK);
  });

  it("stops timer when mode changes", () => {
    useFocusTimer.setState({ isRunning: true });

    get().setMode("longBreak");

    expect(get().isRunning).toBe(false);
  });
});

describe("tick", () => {
  it("does nothing when timer is not running", () => {
    get().tick();

    expect(get().timeLeft).toBe(POMODORO);
  });

  it("decrements by one second", () => {
    useFocusTimer.setState({
      isRunning: true,
      timeLeft: 100,
    });

    get().tick();

    expect(get().timeLeft).toBe(99);
  });

  it("keeps running when moving from 1 to 0", () => {
    useFocusTimer.setState({
      isRunning: true,
      timeLeft: 1,
    });

    get().tick();

    expect(get().timeLeft).toBe(0);
    expect(get().isRunning).toBe(true);
  });

  it("moves pomodoro completion to shortBreak", () => {
    useFocusTimer.setState({
      isRunning: true,
      timeLeft: 0,
      mode: "pomodoro",
      sessionsCompleted: 0,
    });

    get().tick();

    expect(get().mode).toBe("shortBreak");
    expect(get().timeLeft).toBe(SHORT_BREAK);
    expect(get().sessionsCompleted).toBe(1);
  });

  it("moves every fourth pomodoro to longBreak", () => {
    useFocusTimer.setState({
      isRunning: true,
      timeLeft: 0,
      mode: "pomodoro",
      sessionsCompleted: 3,
    });

    get().tick();

    expect(get().mode).toBe("longBreak");
    expect(get().timeLeft).toBe(LONG_BREAK);
    expect(get().sessionsCompleted).toBe(4);
  });

  it("moves shortBreak completion back to pomodoro", () => {
    useFocusTimer.setState({
      isRunning: true,
      timeLeft: 0,
      mode: "shortBreak",
      sessionsCompleted: 1,
    });

    get().tick();

    expect(get().mode).toBe("pomodoro");
    expect(get().timeLeft).toBe(POMODORO);
    expect(get().sessionsCompleted).toBe(1);
  });
});