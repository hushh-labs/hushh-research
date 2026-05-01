import assert from 'node:assert/strict';
import {
  canJoinSearchingMatch,
  calculateMoveResult,
  chooseTossCallerId,
  getPlayerOrder,
  hasMove,
  resolveToss,
  SEARCHING_MATCH_TTL_MS,
} from '../src/lib/rankedBattle';
import { MatchData, MatchPlayer } from '../src/types';

type MatchListener = (match: MatchData) => void;

const testNow = new Date('2026-04-28T00:00:00.000Z');
const testNowMs = testNow.getTime();

const players: Record<string, MatchPlayer> = {
  playerA: { uid: 'ranked-smoke-player-a', displayName: 'Ranked Smoke A', team: 'Mumbai' },
  playerB: { uid: 'ranked-smoke-player-b', displayName: 'Ranked Smoke B', team: 'Chennai' },
  playerC: { uid: 'ranked-smoke-player-c', displayName: 'Ranked Smoke C', team: 'Delhi' },
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

  delete(id: string) {
    this.matches.delete(id);
    this.listeners.delete(id);
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

  findJoinable(uid: string, now = testNowMs) {
    return Array.from(this.matches.values()).find(match => canJoinSearchingMatch(match, uid, now));
  }

  allMatches() {
    return Array.from(this.matches.values());
  }

  private emit(id: string) {
    const match = this.matches.get(id);
    if (!match) return;
    this.listeners.get(id)?.forEach(listener => listener(match));
  }
}

const createSearchingMatch = (
  player: MatchPlayer,
  timestamp: Date | { seconds: number } = testNow,
): Omit<MatchData, 'id'> => ({
  status: 'searching',
  isBotMatch: false,
  players: {
    [player.uid]: player,
  },
  playerOrder: [player.uid],
  currentBatterId: '',
  currentBowlerId: '',
  innings: 1,
  scoreP1: 0,
  scoreP2: 0,
  lastMoves: {},
  history: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

const startRanked = (store: RealtimeMatchStore, player: MatchPlayer, now = testNowMs) => {
  const candidate = store.findJoinable(player.uid, now);
  if (!candidate) {
    return store.create(createSearchingMatch(player));
  }

  return tryJoinRanked(store, candidate.id, player, now) ? candidate.id : startRanked(store, player, now);
};

const tryJoinRanked = (store: RealtimeMatchStore, matchId: string, player: MatchPlayer, now = testNowMs) => {
  const candidate = store.get(matchId);
  if (!canJoinSearchingMatch(candidate, player.uid, now)) return false;
  const playerOrder = [...getPlayerOrder(candidate), player.uid];

  store.update(matchId, {
    status: 'toss',
    players: {
      ...candidate.players,
      [player.uid]: player,
    },
    playerOrder,
    tossCallerId: chooseTossCallerId(playerOrder, () => 0),
    updatedAt: testNow,
  });
  return true;
};

const startPlaying = (store: RealtimeMatchStore, matchId: string, batterId: string) => {
  const match = store.get(matchId);
  const bowlerId = getPlayerOrder(match).find(id => id !== batterId);
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
  const opponentId = getPlayerOrder(match).find(id => id !== uid);
  assert.ok(opponentId, 'Expected opponent to exist');

  if (hasMove(match, uid) && !hasMove(match, opponentId)) {
    submitMove(store, matchId, opponentId, 0);
    return true;
  }

  return false;
};

const resolveTurn = (store: RealtimeMatchStore, matchId: string) => {
  const match = store.get(matchId);
  const pids = getPlayerOrder(match);
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

const test = async (name: string, fn: () => void | string | Promise<void | string>) => {
  await fn();
  return name;
};

const fetchWithTimeout = async (url: string, timeoutMs = 10_000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const deployedSmoke = async () => {
  if (process.env.SKIP_DEPLOYED_SMOKE === '1') return 'deployed app reachability skipped';

  const target = process.env.RANKED_BATTLE_SMOKE_URL || 'https://ipl-arena.hushh.ai';
  const response = await fetchWithTimeout(target);
  assert.equal(response.ok, true, `Expected ${target} to return 2xx/3xx, got ${response.status}`);
  const html = await response.text();
  assert.match(html, /<div id="root"><\/div>/, 'Expected deployed app root element');
  assert.match(html, /hushh IPL Arena/i, 'Expected deployed app title');

  const scriptMatch = html.match(/src="([^"]+\.js)"/);
  assert.ok(scriptMatch?.[1], 'Expected deployed HTML to reference a JS bundle');
  const assetUrl = new URL(scriptMatch[1], target).toString();
  const assetResponse = await fetchWithTimeout(assetUrl);
  assert.equal(assetResponse.ok, true, `Expected deployed JS asset to load, got ${assetResponse.status}`);

  return `deployed app reachable at ${target}`;
};

const tests = [
  test('deployed app reachability', deployedSmoke),

  test('joinability rejects stale, bot, self, full, and non-searching matches', () => {
    const fresh = { ...createSearchingMatch(players.playerA), id: 'fresh' };
    assert.equal(canJoinSearchingMatch(fresh, players.playerB.uid, testNowMs), true);

    const staleTimestamp = new Date(testNowMs - SEARCHING_MATCH_TTL_MS - 1);
    const stale = { ...createSearchingMatch(players.playerA, staleTimestamp), id: 'stale' };
    assert.equal(canJoinSearchingMatch(stale, players.playerB.uid, testNowMs), false);

    const firestoreTimestamp = { seconds: Math.floor(testNowMs / 1000) };
    const firestoreFresh = { ...createSearchingMatch(players.playerA, firestoreTimestamp), id: 'firestore-fresh' };
    assert.equal(canJoinSearchingMatch(firestoreFresh, players.playerB.uid, testNowMs), true);

    assert.equal(canJoinSearchingMatch({ ...fresh, isBotMatch: true }, players.playerB.uid, testNowMs), false);
    assert.equal(canJoinSearchingMatch(fresh, players.playerA.uid, testNowMs), false);
    assert.equal(canJoinSearchingMatch({ ...fresh, status: 'toss' }, players.playerB.uid, testNowMs), false);
    assert.equal(canJoinSearchingMatch({
      ...fresh,
      players: {
        [players.playerA.uid]: players.playerA,
        [players.playerB.uid]: players.playerB,
      },
    }, players.playerC.uid, testNowMs), false);
  }),

  test('two players join one fresh ranked match and both receive realtime updates', () => {
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
  }),

  test('ranked toss has one caller and resolves one batter plus one bowler', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    startRanked(store, players.playerB);

    const match = store.get(matchId);
    assert.deepEqual(getPlayerOrder(match), [players.playerA.uid, players.playerB.uid]);
    assert.equal(match.tossCallerId, players.playerA.uid);
    assert.equal(chooseTossCallerId(getPlayerOrder(match), () => 0.99), players.playerB.uid);

    store.update(matchId, resolveToss(match, match.tossCallerId!, 'heads', 'tails'));
    const tossed = store.get(matchId);
    assert.equal(tossed.tossCall, 'heads');
    assert.equal(tossed.tossResult, 'tails');
    assert.equal(tossed.tossWinnerId, players.playerB.uid);
    assert.equal(tossed.currentBatterId, players.playerB.uid);
    assert.equal(tossed.currentBowlerId, players.playerA.uid);
    assert.notEqual(tossed.currentBatterId, tossed.currentBowlerId);
  }),

  test('concurrent third-player join is rejected after match moves to toss', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);

    assert.equal(tryJoinRanked(store, matchId, players.playerB), true);
    assert.equal(tryJoinRanked(store, matchId, players.playerC), false);
    assert.equal(Object.keys(store.get(matchId).players).length, 2);
  }),

  test('stale searching match is ignored and does not trap the next player', () => {
    const store = new RealtimeMatchStore();
    const stale = createSearchingMatch(players.playerA, new Date(testNowMs - SEARCHING_MATCH_TTL_MS - 1));
    const staleId = store.create(stale);

    const newId = startRanked(store, players.playerB);
    assert.notEqual(newId, staleId);
    assert.equal(store.get(staleId).status, 'searching');
    assert.equal(store.get(newId).status, 'searching');
  }),

  test('cancelling a searching match removes it from the joinable pool', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    store.delete(matchId);
    assert.equal(store.allMatches().length, 0);

    const nextId = startRanked(store, players.playerB);
    assert.equal(store.get(nextId).status, 'searching');
  }),

  test('normal two-player turn resolves once and broadcasts cleared moves', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    startRanked(store, players.playerB);
    startPlaying(store, matchId, players.playerA.uid);

    const playerAUpdates: MatchData[] = [];
    const playerBUpdates: MatchData[] = [];
    store.subscribe(matchId, match => playerAUpdates.push(match));
    store.subscribe(matchId, match => playerBUpdates.push(match));

    submitMove(store, matchId, players.playerA.uid, 4);
    submitMove(store, matchId, players.playerB.uid, 2);
    resolveTurn(store, matchId);

    const match = store.get(matchId);
    assert.equal(match.history.length, 1);
    assert.equal(match.scoreP1, 4);
    assert.deepEqual(match.lastMoves, {});
    assert.equal(latest(playerAUpdates).history.length, 1);
    assert.equal(latest(playerBUpdates).history.length, 1);
  }),

  test('silent opponent timeout resolves as one dot ball and is idempotent', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    startRanked(store, players.playerB);
    startPlaying(store, matchId, players.playerA.uid);

    submitMove(store, matchId, players.playerA.uid, 6);
    assert.equal(timeoutSilentOpponent(store, matchId, players.playerA.uid), true);
    assert.equal(timeoutSilentOpponent(store, matchId, players.playerA.uid), false);
    resolveTurn(store, matchId);

    const match = store.get(matchId);
    assert.equal(match.history.length, 1);
    assert.equal(match.history[0].bat, 6);
    assert.equal(match.history[0].bowl, 0);
    assert.equal(match.scoreP1, 0, 'Timeout dot ball should not add runs');
    assert.equal(match.status, 'playing', 'Timeout dot ball should not create a wicket');
    assert.deepEqual(match.lastMoves, {});
  }),

  test('first-innings wicket switches batting side without ending the match', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    startRanked(store, players.playerB);
    startPlaying(store, matchId, players.playerA.uid);

    submitMove(store, matchId, players.playerA.uid, 3);
    submitMove(store, matchId, players.playerB.uid, 3);
    resolveTurn(store, matchId);

    const match = store.get(matchId);
    assert.equal(match.status, 'playing');
    assert.equal(match.innings, 2);
    assert.equal(match.currentBatterId, players.playerB.uid);
    assert.equal(match.currentBowlerId, players.playerA.uid);
  }),

  test('six legal balls switch innings and six second-innings balls finish as draw when scores tie', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    startRanked(store, players.playerB);
    startPlaying(store, matchId, players.playerA.uid);

    for (let i = 0; i < 6; i += 1) {
      submitMove(store, matchId, players.playerA.uid, 1);
      submitMove(store, matchId, players.playerB.uid, 2);
      resolveTurn(store, matchId);
    }

    let match = store.get(matchId);
    assert.equal(match.innings, 2);
    assert.equal(match.scoreP1, 6);
    assert.equal(match.currentBatterId, players.playerB.uid);

    for (let i = 0; i < 6; i += 1) {
      submitMove(store, matchId, players.playerB.uid, 1);
      submitMove(store, matchId, players.playerA.uid, 2);
      resolveTurn(store, matchId);
    }

    match = store.get(matchId);
    assert.equal(match.status, 'finished');
    assert.equal(match.scoreP1, 6);
    assert.equal(match.scoreP2, 6);
    assert.equal(match.winnerId, 'draw');
  }),

  test('second-innings chase finishes immediately when target is exceeded', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    startRanked(store, players.playerB);
    startPlaying(store, matchId, players.playerA.uid);

    store.update(matchId, {
      innings: 2,
      currentBatterId: players.playerB.uid,
      currentBowlerId: players.playerA.uid,
      scoreP1: 5,
      scoreP2: 0,
      history: [
        { bat: 5, bowl: 1, batterId: players.playerA.uid },
      ],
    });

    submitMove(store, matchId, players.playerB.uid, 6);
    submitMove(store, matchId, players.playerA.uid, 1);
    resolveTurn(store, matchId);

    const match = store.get(matchId);
    assert.equal(match.status, 'finished');
    assert.equal(match.scoreP2, 6);
    assert.equal(match.winnerId, players.playerB.uid);
  }),

  test('second-innings wicket finishes and awards higher score', () => {
    const store = new RealtimeMatchStore();
    const matchId = startRanked(store, players.playerA);
    startRanked(store, players.playerB);
    startPlaying(store, matchId, players.playerA.uid);

    store.update(matchId, {
      innings: 2,
      currentBatterId: players.playerB.uid,
      currentBowlerId: players.playerA.uid,
      scoreP1: 8,
      scoreP2: 3,
      history: [
        { bat: 4, bowl: 1, batterId: players.playerA.uid },
        { bat: 4, bowl: 2, batterId: players.playerA.uid },
        { bat: 3, bowl: 1, batterId: players.playerB.uid },
      ],
    });

    submitMove(store, matchId, players.playerB.uid, 2);
    submitMove(store, matchId, players.playerA.uid, 2);
    resolveTurn(store, matchId);

    const match = store.get(matchId);
    assert.equal(match.status, 'finished');
    assert.equal(match.winnerId, players.playerA.uid);
  }),
];

const results = await Promise.all(tests);

console.log('ranked realtime automation passed:', {
  tests: results.length,
  coverage: results,
});
