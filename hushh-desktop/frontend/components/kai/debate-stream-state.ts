export function getInitialRoundCollapseState(): Record<number, boolean> {
  return { 1: false, 2: true };
}

export function getRoundCollapseStateForRound(round: 1 | 2): Record<number, boolean> {
  if (round === 2) {
    return { 1: true, 2: false };
  }
  return getInitialRoundCollapseState();
}

export function getRoundCollapseStateForDecision(): Record<number, boolean> {
  return { 1: true, 2: false };
}
