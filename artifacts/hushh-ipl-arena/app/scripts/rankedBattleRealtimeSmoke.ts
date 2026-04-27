import assert from 'node:assert/strict';
import { canJoinSearchingMatch, calculateMoveResult, hasMove } from '../src/lib/rankedBattle';
import { MatchData, MatchPlayer } from '../src/types';

type MatchListener = (match: MatchData) => void;

const testNow = new Date('2026-04-28T00:00:00.000Z');

const players: Record<string, MatchPlayer> = {
  playerA: { uid: 'ranked-smoke-player-a', displayName: 'Ranked Smoke A', team: 'Mumbai' },
  playerB: { uid: 'ranked-smoke-player-b', displayName: 'Ranked Smoke B', team: 'Chennai' },
};

class RealtimeMatchStore {
  private matches = new Map<string, MatchData>();
  private listeners = new Map<string, Set<MatchListener>>();
  private sequence = 0;

  create(match: Omit<MatchData, 'id'>) {
    const id = `ranked-smoke-${++this.sequence}`;
    const created: MatchData = { ...match, id };
    this.matches.set(id, created);
    this.emit(id);
    return id;
  }

  get(id: string) {
    const match = this.matches.get(id);
    assert.ok(match, `Expected match ${id} to exist`);
    return match;
  }

  update(id: string, update: Partial<MatchData>) {
    const next = { ...this.get(id), ...update } as MatchData;
    this.matches.set(id, next);
    this.emit(id);
    return next;
  }

  subscribe(id: string, listener: MatchListener) {
    if (!this.listeners.has(id)) {
      this.listeners.set(id, new Set());
    }
    this.listeners.get(id)!.add(listener);
    listener(this.get(id));
    return () => this.listeners.get(id)?.delete(listener);
  }

  findJoinable(uid: string, now = testNow.getTime()) {
    return Array.from(this.matches.values()).find(match => canJoinSearchingMatch(match, uid, now));
  }

  private emit(id: string) {
    const match = this.matches.get(id);
    if (!match) return;
    this.listeners.get(id)?.forEach(listener => listener(match));
  }
}

const createSearchingMatch = (player: MatchPlayer): Omit<MatchData, 'id'> => ({
  status: 'searching',
  isBotMatch: false,
  players: {
    [player.uid]: player,
  },
  currentBatterId: '',
  currentBowlerId: '',
  innings: 1,
  scoreP1: 0,
  scoreP2: 0,
  lastMoves: {},
  history: [],
  createdAt: testNow,
  updatedAt: testNow,
});

const startRanked = (store: RealtimeMatchStore, player: MatchPlayer) => {
  const candidate = store.findJoinable(player.uid);
  if (!candidate) {
    return store.create(createSearchingMatch(player));
  }

  return store.update(candidate.id, {
    status: 'toss',
    players: {
      ...candidate.players,
      [player.uid]: player,
    },
    updatedAt: testNow,
  }).id;
};

const startPlaying = (store: RealtimeMatchStore, matchId: string, batterId: string) => {
  const match = store.get(matchId);
  const bowlerId = Object.keys(match.players).find(id => id !== batterId);
  assert.ok(bowlerId, 'Expected a second player before play starts');

  store.update(matchId, {
    status: 'playing',
    currentBatterId: batterId,
    currentBowlerId: bowlerId,
    tossWinnerId: batterId,
    updatedAt: testNow,
  });
};

const submitMove = (store: RealtimeMatchStore, matchId: string, uid: string, move: number) => {
  const match = store.get(matchId);
  store.update(matchId, {
    lastMoves: {
      ...match.lastMoves,
      [uid]: move,
    },
    updatedAt: testNow,
  });
};

const timeoutSilentOpponent = (store: RealtimeMatchStore, matchId: string, uid: string) => {
  const match = store.get(matchId);
  const opponentId = Object.keys(match.players).find(id => id !== uid);
  assert.ok(opponentId, 'Expected opponent to exist');

  if (hasMove(match, uid) && !hasMove(match, opponentId)) {
    submitMove(store, matchId, opponentId, 0);
  }
};

const resolveTurn = (store: RealtimeMatchStore, matchId: string) => {
  const match = store.get(matchId);
  const pids = Object.keys(match.players);
  assert.equal(pids.length, 2, 'Expected exactly two players');
  assert.ok(hasMove(match, pids[0]), 'Expected player one move');
  assert.ok(hasMove(match, pids[1]), 'Expected player two move');

  const p1 = match.lastMoves[pids[0]];
  const p2 = match.lastMoves[pids[1]];
  const bat = match.currentBatterId === pids[0] ? p1 : p2;
  const bowl = match.currentBatterId === pids[0] ? p2 : p1;
  store.update(matchId, {
    ...calculateMoveResult(match, bat, bowl),
    updatedAt: testNow,
  });
};

const latest = (updates: MatchData[]) => updates[updates.length - 1];

const store = new RealtimeMatchStore();

const matchIdA = startRanked(store, players.playerA);
assert.equal(store.get(matchIdA).status, 'searching');

const playerAUpdates: MatchData[] = [];
store.subscribe(matchIdA, match => playerAUpdates.push(match));

const matchIdB = startRanked(store, players.playerB);
assert.equal(matchIdB, matchIdA, 'Second ranked player should join the existing match');
assert.equal(store.get(matchIdA).status, 'toss');
assert.equal(Object.keys(store.get(matchIdA).players).length, 2);

const playerBUpdates: MatchData[] = [];
store.subscribe(matchIdB, match => playerBUpdates.push(match));
assert.equal(latest(playerAUpdates).status, 'toss');
assert.equal(latest(playerBUpdates).status, 'toss');

startPlaying(store, matchIdA, players.playerA.uid);
assert.equal(latest(playerAUpdates).status, 'playing');
assert.equal(latest(playerBUpdates).status, 'playing');

submitMove(store, matchIdA, players.playerA.uid, 4);
submitMove(store, matchIdA, players.playerB.uid, 2);
resolveTurn(store, matchIdA);

let match = store.get(matchIdA);
assert.equal(match.history.length, 1);
assert.equal(match.scoreP1, 4);
assert.deepEqual(match.lastMoves, {});
assert.equal(latest(playerAUpdates).history.length, 1);
assert.equal(latest(playerBUpdates).history.length, 1);

submitMove(store, matchIdA, players.playerA.uid, 6);
timeoutSilentOpponent(store, matchIdA, players.playerA.uid);
resolveTurn(store, matchIdA);

match = store.get(matchIdA);
assert.equal(match.history.length, 2);
assert.equal(match.scoreP1, 4, 'Silent opponent timeout should resolve as a dot ball');
assert.deepEqual(match.lastMoves, {});
assert.equal(latest(playerAUpdates).history.length, 2);
assert.equal(latest(playerBUpdates).history.length, 2);

console.log('ranked realtime smoke passed:', {
  matchId: match.id,
  players: Object.keys(match.players).length,
  updatesSeenByPlayerA: playerAUpdates.length,
  updatesSeenByPlayerB: playerBUpdates.length,
  history: match.history.length,
  scoreP1: match.scoreP1,
  scoreP2: match.scoreP2,
});
