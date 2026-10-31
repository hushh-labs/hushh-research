import type { CircleWarsState } from "@/lib/services/circle-wars-service";

export type CircleWarsClock = { roundId: string; receivedAt: number; remainingMs: number };

/** The persisted server deadline owns the timer; the device wall clock never does. */
export function circleWarsClock(state: CircleWarsState): CircleWarsClock {
  const cutoff = Date.parse(state.period.ends_at);
  const server = Date.parse(state.period.server_now);
  return {
    roundId: state.period.round_id,
    receivedAt: state.received_at_monotonic ?? performance.now(),
    remainingMs: Number.isFinite(cutoff) && Number.isFinite(server)
      ? Math.max(0, cutoff - server)
      : Math.max(0, state.period.seconds_remaining * 1000),
  };
}

export function circleWarsRemainingMs(clock: CircleWarsClock, now = performance.now()): number {
  return Math.max(0, clock.remainingMs - Math.max(0, now - clock.receivedAt));
}
