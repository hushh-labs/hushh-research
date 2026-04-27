import { MatchData, MatchMove } from '../types';

export const SEARCHING_MATCH_TTL_MS = 30_000;
export const OPPONENT_MOVE_TIMEOUT_MS = 8_000;

export const toMillis = (value: any) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

export const isFreshSearchingMatch = (data: Pick<MatchData, 'createdAt' | 'updatedAt'>, now = Date.now()) => {
  const lastSeen = toMillis(data.updatedAt) || toMillis(data.createdAt);
  return lastSeen > 0 && now - lastSeen <= SEARCHING_MATCH_TTL_MS;
};

export const canJoinSearchingMatch = (data: MatchData, uid: string, now = Date.now()) => {
  const players = data.players || {};
  return data.status === 'searching'
    && !data.isBotMatch
    && !players[uid]
    && Object.keys(players).length === 1
    && isFreshSearchingMatch(data, now);
};

export const hasMove = (match: MatchData, uid: string) => (
  Object.prototype.hasOwnProperty.call(match.lastMoves || {}, uid)
);

export const calculateMoveResult = (match: MatchData, bat: number, bowl: number): Partial<MatchData> => {
  let newScoreP1 = match.scoreP1;
  let newScoreP2 = match.scoreP2;
  let newStatus = match.status;
  let newInnings = match.innings;
  let newBatterId = match.currentBatterId;
  let newBowlerId = match.currentBowlerId;
  let newWinnerId = match.winnerId;
  const pids = Object.keys(match.players);
  const p1Id = pids[0];
  const p2Id = pids[1];

  const isP1Batting = match.currentBatterId === p1Id;
  const wasSecondInnings = match.innings === 2;

  const newMove: MatchMove = { bat, bowl, batterId: newBatterId };
  const newHistory = [...match.history, newMove];

  const currentBatterHistory = newHistory.filter(m => m.batterId === match.currentBatterId);
  const ballsFacedThisInnings = currentBatterHistory.length;

  if (bat === 0 || bowl === 0) {
    // Dot ball due to timeout: zero runs and no wicket taken.
  } else if (bat === bowl) {
    if (newInnings === 1) {
      newInnings = 2;
      newBatterId = match.currentBowlerId;
      newBowlerId = match.currentBatterId;
    } else {
      newStatus = 'finished';
    }
  } else {
    if (isP1Batting) newScoreP1 += bat;
    else newScoreP2 += bat;
  }

  if (wasSecondInnings && newStatus !== 'finished') {
    const target = isP1Batting ? match.scoreP2 : match.scoreP1;
    const currentScore = isP1Batting ? newScoreP1 : newScoreP2;
    if (currentScore > target) {
      newStatus = 'finished';
      newWinnerId = match.currentBatterId;
    }
  }

  if (newStatus !== 'finished' && newInnings === match.innings && ballsFacedThisInnings >= 6) {
    if (newInnings === 1) {
      newInnings = 2;
      newBatterId = match.currentBowlerId;
      newBowlerId = match.currentBatterId;
    } else {
      newStatus = 'finished';
    }
  }

  if (newStatus === 'finished') {
    if (newScoreP1 > newScoreP2) newWinnerId = p1Id;
    else if (newScoreP2 > newScoreP1) newWinnerId = p2Id;
    else newWinnerId = 'draw';
  }

  const updates: Partial<MatchData> = {
    scoreP1: newScoreP1,
    scoreP2: newScoreP2,
    status: newStatus,
    innings: newInnings,
    currentBatterId: newBatterId,
    currentBowlerId: newBowlerId,
    lastMoves: {},
    history: newHistory,
  };

  if (newWinnerId !== undefined) {
    updates.winnerId = newWinnerId;
  }

  return updates;
};
