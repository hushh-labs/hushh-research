export type Team = 'Chennai' | 'Bengaluru' | 'Delhi' | 'Kolkata' | 'Mumbai' | 'Hyderabad' | 'hushh';

export interface UserProfile {
  uid: string;
  displayName: string;
  team: Team;
  gamesPlayed24h: number;
  botGamesPlayed24h: number;
  lastResetTime: any;
  lastClaimedReward?: any;
  xp?: number;
  streak?: number;
  totalWins: number;
  totalRuns: number;
  totalGamesPlayed?: number;
  highestScore?: number;
  lastMatchId?: string;
}

export type MatchStatus = 'searching' | 'toss' | 'playing' | 'finished';

export interface MatchPlayer {
  uid: string;
  displayName: string;
  team: Team;
  role?: 'batting' | 'bowling';
}

export interface MatchMove {
  bat: number;
  bowl: number;
  batterId: string;
}

export interface MatchData {
  id: string;
  status: MatchStatus;
  players: Record<string, MatchPlayer>;
  isBotMatch: boolean;
  botDifficulty?: 'easy' | 'medium' | 'hard';
  currentBatterId: string;
  currentBowlerId: string;
  innings: 1 | 2;
  scoreP1: number;
  scoreP2: number;
  target?: number;
  lastMoves: Record<string, number>; // uid -> choice
  history: MatchMove[];
  winnerId?: string;
  tossWinnerId?: string;
  tossChoice?: 'odd' | 'even';
  createdAt: any;
  updatedAt: any;
}
