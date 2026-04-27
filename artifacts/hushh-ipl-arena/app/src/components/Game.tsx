import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { doc, onSnapshot, updateDoc, serverTimestamp, getDoc, setDoc, increment, getDocFromServer } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrorHandler';
import { db } from '../firebase';
import { UserProfile, MatchData, MatchMove, Team } from '../types';
import { cn } from '../lib/utils';
import { Trophy, Home, RotateCcw, Swords, ChevronRight } from 'lucide-react';

import { audio } from '../lib/audioManager';

interface GameProps {
  matchId: string;
  practiceDifficulty?: 'easy' | 'medium' | 'hard';
  profile: UserProfile;
  onClose: () => void;
  onUpdateProfile: (updated: UserProfile) => void;
}

const NUMBERS = [1, 2, 3, 4, 5, 6];

export default function Game({ matchId, practiceDifficulty, profile, onClose, onUpdateProfile }: GameProps) {
  const [match, setMatch] = useState<MatchData | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [lastReveal, setLastReveal] = useState<{ bat: number; bowl: number } | null>(null);
  const [myChoice, setMyChoice] = useState<number | null>(null);
  const lastProcessedMoveRef = useRef<number>(0);

  const isPractice = matchId === 'practice';

  useEffect(() => {
    if (isPractice) {
      // Setup local practice state
      const initialMatch: MatchData = {
        id: 'practice',
        status: 'toss',
        players: {
          [profile.uid]: { uid: profile.uid, displayName: profile.displayName, team: profile.team },
          'bot': { uid: 'bot', displayName: 'hushh bot', team: 'hushh' }
        },
        isBotMatch: true,
        botDifficulty: practiceDifficulty,
        currentBatterId: '',
        currentBowlerId: '',
        innings: 1,
        scoreP1: 0,
        scoreP2: 0,
        lastMoves: {},
        history: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };
      setMatch(initialMatch);
      return;
    }

    const unsub = onSnapshot(doc(db, 'matches', matchId), (d) => {
      if (d.exists()) {
        const data = d.data() as MatchData;
        setMatch({ ...data, id: d.id });
      }
    });

    return () => unsub();
  }, [matchId]);

  // Logic: Both players chose? Reveal and Update
  useEffect(() => {
    if (!match || match.status !== 'playing' || revealing) return;

    const pids = Object.keys(match.players);
    if (match.lastMoves[pids[0]] && match.lastMoves[pids[1]]) {
      const p1 = match.lastMoves[pids[0]];
      const p2 = match.lastMoves[pids[1]];

      const batVal = match.currentBatterId === pids[0] ? p1 : p2;
      const bowlVal = match.currentBatterId === pids[0] ? p2 : p1;

      setLastReveal({ bat: batVal, bowl: bowlVal });
      setRevealing(true);
      setMyChoice(null);

      if (batVal === bowlVal) {
        audio.playOut();
      } else {
        audio.playScore();
      }

      // Only host or logic owner updates
      const isHost = pids[0] === profile.uid || (match.isBotMatch && profile.uid !== 'bot');

      setTimeout(async () => {
        if (isHost) {
          await handleMoveCalculation(batVal, bowlVal);
        }
        setRevealing(false);
      }, 2000);
    }
  }, [match?.lastMoves]);

  const handleMoveCalculation = async (bat: number, bowl: number) => {
    if (!match) return;

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

    const newMove: MatchMove = { bat, bowl, batterId: newBatterId };
    const newHistory = [...match.history, newMove];

    const currentBatterHistory = newHistory.filter(m => m.batterId === match.currentBatterId);
    const ballsFacedThisInnings = currentBatterHistory.length;

    if (bat === 0 || bowl === 0) {
      // Dot ball due to timeout: zero runs and no wicket taken
    } else if (bat === bowl) {
      // OUT!
      if (newInnings === 1) {
        newInnings = 2;
        newBatterId = match.currentBowlerId;
        newBowlerId = match.currentBatterId;
      } else {
        // Match over
        newStatus = 'finished';
      }
    } else {
      // Scored runs
      if (isP1Batting) newScoreP1 += bat;
      else newScoreP2 += bat;
    }

    // Check target chased for innings 2
    if (newInnings === 2 && newStatus !== 'finished') {
      const target = isP1Batting ? match.scoreP2 : match.scoreP1;
      const currentScore = isP1Batting ? newScoreP1 : newScoreP2;
      if (currentScore > target) {
        newStatus = 'finished';
        newWinnerId = match.currentBatterId;
      }
    }

    // 1-Over match limit (6 balls max per innings)
    if (newStatus !== 'finished' && newInnings === match.innings) { // Haven't gotten out yet
       if (ballsFacedThisInnings >= 6) {
          if (newInnings === 1) {
             newInnings = 2;
             newBatterId = match.currentBowlerId;
             newBowlerId = match.currentBatterId;
          } else {
             newStatus = 'finished';
          }
       }
    }

    // Finally, if finished, determine winner safely
    if (newStatus === 'finished') {
       if (newScoreP1 > newScoreP2) newWinnerId = p1Id;
       else if (newScoreP2 > newScoreP1) newWinnerId = p2Id;
       else newWinnerId = 'draw';
    }

    const updates: any = {
      scoreP1: newScoreP1,
      scoreP2: newScoreP2,
      status: newStatus,
      innings: newInnings,
      currentBatterId: newBatterId,
      currentBowlerId: newBowlerId,
      lastMoves: {},
      history: newHistory,
      updatedAt: serverTimestamp()
    };
    if (newWinnerId !== undefined) {
      updates.winnerId = newWinnerId;
    }

    if (isPractice) {
      setMatch({ ...match, ...updates });
    } else {
      await updateDoc(doc(db, 'matches', matchId), updates);
      if (newStatus === 'finished') {
        await updateStats(newWinnerId === profile.uid, isP1Batting ? newScoreP1 : newScoreP2);
      }
    }
  };

  const updateStats = async (isWin: boolean, finalRuns: number) => {
    const path = `users/${profile.uid}`;
    try {
      const userRef = doc(db, 'users', profile.uid);

      // Calculate Wickets Taken by ME
      const widgetsTaken = match?.history.filter(m => m.bat === m.bowl && m.bat !== 0 && m.batterId !== profile.uid).length || 0;

      // Calculate Wickets Lost by ME (not needed for XP but good to know)
      // Base XP
      let xpEarned = 10 + finalRuns + (widgetsTaken * 10);

      // Win Bonus & Limits
      const isBotMatch = !!match?.isBotMatch;
      let winBonus = 0;

      if (isWin) {
        if (isBotMatch) {
          const diff = match.botDifficulty;
          if (diff === 'hard') winBonus = 60;
          else if (diff === 'medium') winBonus = 30;
          else winBonus = 10;
        } else {
          winBonus = 100;
        }
      }

      xpEarned += winBonus;

      // Max Limits to prevent fraud/farming
      const maxLimit = isBotMatch ? 150 : 400;
      xpEarned = Math.min(xpEarned, maxLimit);

      const newHighestScore = Math.max(profile.highestScore || 0, finalRuns);

      const statsUpdate = {
        gamesPlayed24h: increment(1),
        botGamesPlayed24h: isBotMatch ? increment(1) : increment(0),
        totalWins: isWin ? increment(1) : increment(0),
        totalRuns: increment(finalRuns),
        totalGamesPlayed: increment(1),
        highestScore: newHighestScore,
        xp: increment(xpEarned),
        lastMatchId: matchId
      };
      await updateDoc(userRef, statsUpdate);

      onUpdateProfile({
        ...profile,
        gamesPlayed24h: (profile.gamesPlayed24h || 0) + 1,
        totalWins: isWin ? (profile.totalWins || 0) + 1 : profile.totalWins,
        totalRuns: (profile.totalRuns || 0) + finalRuns,
        totalGamesPlayed: (profile.totalGamesPlayed || 0) + 1,
        highestScore: newHighestScore,
        xp: (profile.xp || 0) + xpEarned
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, path);
    }
  };

  const [isTossing, setIsTossing] = useState(false);
  const [tossResult, setTossResult] = useState<'heads' | 'tails' | null>(null);

  const [timeLeft, setTimeLeft] = useState(4000);
  const currentTurnKey = match?.history?.length || 0;
  const submitMoveRef = useRef<((num: number) => Promise<void>) | null>(null);

  const handleToss = async (choice: 'heads' | 'tails') => {
    if (!match || isTossing) return;

    setIsTossing(true);
    audio.playToss();
    // Determine result
    const result = Math.random() > 0.5 ? 'heads' : 'tails';

    // Animation delay
    setTimeout(async () => {
      setTossResult(result);
      setIsTossing(false);
      const won = choice === result;

      if (won) {
        audio.playTossWin();
      } else {
        audio.playLose(); // small negative tone
      }

      const pids = Object.keys(match.players);
      const winner = won ? profile.uid : (match.isBotMatch ? 'bot' : pids.find(id => id !== profile.uid)!);

      // Hold the result on screen for 3 seconds before starting the match
      setTimeout(async () => {
        if (isPractice) {
          setMatch({
            ...match,
            status: 'playing',
            currentBatterId: winner,
            currentBowlerId: winner === profile.uid ? 'bot' : profile.uid,
            tossWinnerId: winner
          });
        } else {
           await updateDoc(doc(db, 'matches', matchId), {
            status: 'playing',
            currentBatterId: winner,
            currentBowlerId: pids.find(id => id !== winner)!,
            tossWinnerId: winner,
            updatedAt: serverTimestamp()
          } as any);
        }
      }, 3000);
    }, 2500);
  };

  const submitMove = async (num: number) => {
    if (!match || revealing || myChoice !== null) return;
    audio.playTap();
    setMyChoice(num);

    if (isPractice || match.isBotMatch) {
      const difficulty = isPractice ? practiceDifficulty : match.botDifficulty;

      let botMove = Math.floor(Math.random() * 6) + 1;

      const pids = Object.keys(match.players);
      const isBotBatting = match.currentBatterId !== profile.uid;

      if (difficulty === 'medium') {
        // Medium: Bot occasionally avoids repeating its own previous move to be less predictable
        const lastBotMove = match.history.length > 0
          ? (isBotBatting ? match.history[match.history.length - 1].bat : match.history[match.history.length - 1].bowl)
          : null;

        if (lastBotMove && Math.random() > 0.4) { // 60% chance to avoid repeating
          const choices = [1, 2, 3, 4, 5, 6].filter(n => n !== lastBotMove);
          botMove = choices[Math.floor(Math.random() * choices.length)];
        }
      } else if (difficulty === 'hard') {
        // Hard: Analyze player's patterns
        const lastPlayerMove = match.history.length > 0
          ? (!isBotBatting ? match.history[match.history.length - 1].bat : match.history[match.history.length - 1].bowl)
          : null;

        // 80% chance to use advanced logic in hard mode
        if (Math.random() > 0.2) {
          if (isBotBatting) {
             // Bot is batting: The bot wants to AVOID picking the same number the player bowls.
             // If player tends to repeat their last bowl, bot should avoid it.
             let evasionChoices = [1, 2, 3, 4, 5, 6];
             if (lastPlayerMove) {
               evasionChoices = evasionChoices.filter(n => n !== lastPlayerMove);
             }
             botMove = evasionChoices[Math.floor(Math.random() * evasionChoices.length)];
          } else {
             // Bot is bowling: The bot wants to MATCH the player's bat.
             // Players often repeat moves, or play 1, 4, 6.
             if (lastPlayerMove && Math.random() > 0.4) {
                 botMove = lastPlayerMove;
             } else {
                 const playerCommonMoves = [1, 4, 6, lastPlayerMove].filter(Boolean) as number[];
                 botMove = playerCommonMoves[Math.floor(Math.random() * playerCommonMoves.length)];
             }
          }
        }
      }

      const updates = {
        lastMoves: {
          [profile.uid]: num,
          'bot': botMove
        }
      };
      if (isPractice) {
        setMatch({ ...match, ...updates });
      } else {
        await updateDoc(doc(db, 'matches', matchId), updates);
      }
    } else {
      await updateDoc(doc(db, 'matches', matchId), {
        [`lastMoves.${profile.uid}`]: num
      });
    }
  };

  submitMoveRef.current = submitMove;

  useEffect(() => {
    if (match?.status !== 'playing' || myChoice !== null || revealing) {
      setTimeLeft(4000);
      return;
    }

    setTimeLeft(4000);
    const endTime = Date.now() + 4000;

    const interval = setInterval(() => {
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        clearInterval(interval);
        setTimeLeft(0);
        submitMoveRef.current?.(0);
      } else {
        setTimeLeft(remaining);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [match?.status, myChoice, revealing, currentTurnKey]);

  useEffect(() => {
    if (match?.status === 'finished') {
       if (match.winnerId === profile.uid) {
         audio.playWin();
       } else if (match.winnerId !== 'draw') {
         audio.playLose();
       }
    }
  }, [match?.status]);

  if (!match) return null;

  const pids = Object.keys(match.players);
  const p1 = match.players[pids[0]];
  const p2 = match.players[pids[1]];
  const isMeBatting = match.currentBatterId === profile.uid;
  const myOpponent = pids.find(id => id !== profile.uid)!;
  const opponentProfile = match.players[myOpponent];

  const p1BallsFaced = match.history?.filter(m => m.batterId === pids[0]).length || 0;
  const p1StrikeRate = p1BallsFaced > 0 ? ((match.scoreP1 / p1BallsFaced) * 100).toFixed(0) : 0;
  const p2BallsFaced = match.history?.filter(m => m.batterId === pids[1]).length || 0;
  const p2StrikeRate = p2BallsFaced > 0 ? ((match.scoreP2 / p2BallsFaced) * 100).toFixed(0) : 0;

  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.9, opacity: 0 }}
      className="w-full flex-1 flex flex-col pt-12 pb-8 px-4 lg:px-12 bg-[#F0F7FF]"
    >
      {/* Top Header / Scoreboard */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-4 lg:mb-8 max-w-5xl mx-auto w-full">
        <ScoreCard
          player={p1}
          isBatting={match.currentBatterId === pids[0]}
          runs={match.scoreP1}
          balls={p1BallsFaced}
          strikeRate={p1StrikeRate}
          side="left"
        />
        <div className="flex flex-col items-center flex-shrink-0">
             <div className="bg-slate-800 text-[10px] font-black px-3 py-1 rounded mb-1 text-white uppercase tracking-[0.2em] leading-none">VS</div>
             <div className="bg-white px-3 py-1 rounded-full text-[10px] font-black text-slate-400 uppercase tracking-widest border border-slate-100 shadow-sm whitespace-nowrap">
               {match.innings === 1 ? 'INN 1' : 'TGT: ' + (pids[0] === match.currentBatterId ? (match.scoreP2 + 1) : (match.scoreP1 + 1))}
             </div>
        </div>
        <ScoreCard
          player={p2}
          isBatting={match.currentBatterId === pids[1]}
          runs={match.scoreP2}
          balls={p2BallsFaced}
          strikeRate={p2StrikeRate}
          side="right"
        />
      </div>

      {/* Main Arena Area */}
      <div className="flex-1 flex flex-col lg:flex-row gap-8 items-center justify-center max-w-6xl mx-auto w-full">
        <div className="flex-1 w-full max-w-2xl flex flex-col items-center justify-center relative p-4 lg:p-8 bg-white rounded-[32px] lg:rounded-[48px] border-4 border-white shadow-xl overflow-hidden min-h-[400px] lg:min-h-[500px] flex-shrink-0">
          <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-teal-50 to-transparent pointer-events-none" />

          <AnimatePresence mode="wait">
            {match.status === 'toss' && (
              <motion.div
                key="toss"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center relative z-10 flex flex-col items-center"
              >
                {!isTossing && !tossResult ? (
                  <>
                    <h2 className="text-3xl font-black mb-8 text-teal-600 uppercase tracking-tighter">
                      {pids[0] === profile.uid || match.isBotMatch ? "CALL THE TOSS" : "OPPONENT IS TOSSING"}
                    </h2>
                    {pids[0] === profile.uid || match.isBotMatch ? (
                      <div className="flex gap-6">
                        <button
                          onClick={() => handleToss('heads')}
                          className="bg-[#34C759] text-white w-32 py-8 rounded-[32px] font-bold text-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all uppercase"
                        >HEADS</button>
                        <button
                          onClick={() => handleToss('tails')}
                          className="bg-[#FF9500] text-white w-32 py-8 rounded-[32px] font-bold text-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all uppercase"
                        >TAILS</button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center h-32">
                        <div className="w-12 h-12 border-4 border-slate-200 border-t-teal-500 rounded-full animate-spin"></div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center">
                    <motion.div
                      animate={{
                        rotateY: isTossing ? [0, 1800] : 0,
                        y: isTossing ? [0, -100, 0] : 0
                      }}
                      transition={{
                        duration: 2.5,
                        ease: "easeInOut"
                      }}
                      className="w-32 h-32 rounded-full bg-gradient-to-br from-yellow-400 to-yellow-600 border-4 border-yellow-200 shadow-2xl flex items-center justify-center mb-8"
                    >
                      <span className="text-3xl font-black text-yellow-100 uppercase tracking-widest">
                        {isTossing ? "?" : (tossResult === 'heads' ? "H" : "T")}
                      </span>
                    </motion.div>
                    <h2 className="text-2xl font-black text-slate-800 uppercase tracking-widest animate-pulse mb-2">
                      {isTossing ? "Flipping..." : (tossResult === 'heads' ? "HEADS!" : "TAILS!")}
                    </h2>
                    {!isTossing && tossResult && (
                       <p className="text-teal-600 font-bold uppercase tracking-widest mt-4">
                         Match starting...
                       </p>
                    )}
                  </div>
                )}
              </motion.div>
            )}

            {match.status === 'playing' && (
              <motion.div key="playing" className="w-full flex flex-col items-center relative z-10">
                {myChoice === null && !revealing && (
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 w-48 h-2 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                    <div
                      className={cn("h-full transition-all duration-75", timeLeft < 1000 ? "bg-red-500" : "bg-teal-500")}
                      style={{ width: `${Math.max(0, (timeLeft / 4000) * 100)}%` }}
                    />
                  </div>
                )}
                <div className="bg-orange-100 text-orange-600 px-6 py-2 rounded-full text-sm font-black uppercase tracking-widest mb-12 border-2 border-orange-200">
                  {isMeBatting ? "You are Batting" : "You are Bowling"}
                </div>

                {/* Hands Animation */}
                <div className="flex justify-between w-full max-w-[400px] mb-8 lg:mb-12 px-4 lg:px-0 gap-4 lg:gap-8">
                  <Hand
                    value={revealing ? lastReveal?.bat : (myChoice !== null && isMeBatting ? myChoice : null)}
                    side="left"
                    color={isMeBatting ? "teal" : "slate"}
                    label={isMeBatting ? "YOU" : opponentProfile?.displayName || 'Opponent'}
                  />
                  <Hand
                    value={revealing ? lastReveal?.bowl : (myChoice !== null && !isMeBatting ? myChoice : null)}
                    side="right"
                    color={isMeBatting ? "slate" : "teal"}
                    label={!isMeBatting ? "YOU" : opponentProfile?.displayName || 'Opponent'}
                  />
                </div>

                {/* Status Message */}
                <div className="text-center mb-8 h-16 flex items-center justify-center">
                  {revealing ? (
                    <motion.div
                      key="result"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{
                        scale: 1.2,
                        opacity: 1,
                        x: lastReveal?.bat === lastReveal?.bowl ? [0, -10, 10, -10, 10, 0] : 0
                      }}
                      className={cn("text-5xl font-black drop-shadow-md tracking-tighter uppercase", lastReveal?.bat === lastReveal?.bowl ? "text-orange-500" : "text-teal-600")}
                    >
                      {lastReveal?.bat === lastReveal?.bowl ? "OUT!" : `+${lastReveal?.bat} RUNS`}
                    </motion.div>
                  ) : (
                    <p className="text-slate-400 font-extrabold uppercase tracking-[0.3em] text-xs">
                      {myChoice ? "Awaiting opponent..." : "Pick your magic number"}
                    </p>
                  )}
                </div>
              </motion.div>
            )}

            {match.status === 'finished' && (
              <motion.div
                key="finished"
                initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                className="w-full text-center relative z-10 p-4"
              >
                <div className={cn(
                  "w-20 h-20 lg:w-28 lg:h-28 mx-auto mb-6 flex items-center justify-center rounded-[24px] lg:rounded-[32px] rotate-12 shadow-2xl",
                  match.winnerId === profile.uid ? "bg-[#34C759]" : (match.winnerId === 'draw' ? "bg-[#FFCC00]" : "bg-[#FF3B30]")
                )}>
                  <Trophy className="w-10 h-10 lg:w-14 lg:h-14 text-white" />
                </div>
                <h2 className="text-4xl lg:text-5xl font-black mb-2 tracking-tight text-black uppercase">
                  {match.winnerId === profile.uid ? "VICTORY!" : (match.winnerId === 'draw' ? "DRAW!" : "DEFEAT")}
                </h2>
                <p className="text-black/60 mb-8 font-black uppercase text-xs lg:text-sm tracking-widest opacity-60">
                  {match.winnerId === profile.uid ? "You claimed the win!" : (match.winnerId === 'draw' ? "It's a tie!" : "Better luck next time!")}
                </p>

                <div className="grid grid-cols-2 gap-4 max-w-lg mx-auto mb-10">
                  <div className={cn("p-4 rounded-2xl border-2 flex flex-col items-center", match.winnerId === pids[0] ? "border-orange-500 bg-orange-50 shadow-sm" : "border-slate-200 bg-slate-50")}>
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 truncate w-full">{p1?.displayName || 'Player 1'}</span>
                    <span className="text-4xl font-black text-slate-800 tracking-tighter mb-2">{match.scoreP1}</span>
                    <div className="flex gap-4 w-full justify-center">
                      <div className="flex flex-col items-center"><span className="text-[9px] font-bold text-slate-400 uppercase">Balls</span><span className="font-black text-slate-600 border-t border-slate-200 mt-1 pt-1 w-full">{p1BallsFaced}</span></div>
                      <div className="flex flex-col items-center"><span className="text-[9px] font-bold text-slate-400 uppercase">SR</span><span className="font-black text-slate-600 border-t border-slate-200 mt-1 pt-1 w-full">{p1StrikeRate}</span></div>
                    </div>
                  </div>
                  <div className={cn("p-4 rounded-2xl border-2 flex flex-col items-center", match.winnerId === pids[1] ? "border-orange-500 bg-orange-50 shadow-sm" : "border-slate-200 bg-slate-50")}>
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 truncate w-full">{p2?.displayName || 'Player 2'}</span>
                    <span className="text-4xl font-black text-slate-800 tracking-tighter mb-2">{match.scoreP2}</span>
                    <div className="flex gap-4 w-full justify-center">
                      <div className="flex flex-col items-center"><span className="text-[9px] font-bold text-slate-400 uppercase">Balls</span><span className="font-black text-slate-600 border-t border-slate-200 mt-1 pt-1 w-full">{p2BallsFaced}</span></div>
                      <div className="flex flex-col items-center"><span className="text-[9px] font-bold text-slate-400 uppercase">SR</span><span className="font-black text-slate-600 border-t border-slate-200 mt-1 pt-1 w-full">{p2StrikeRate}</span></div>
                    </div>
                  </div>
                </div>

                <div className="flex gap-4 max-w-sm mx-auto">
                  <button
                    onClick={onClose}
                    className="flex-1 bg-white border border-[#E5E5EA] py-4 lg:py-5 rounded-full font-bold text-black flex items-center justify-center gap-2 hover:bg-white/90 shadow-[0_8px_30px_rgb(0,0,0,0.04)] uppercase text-sm lg:text-lg transition-all active:scale-95"
                  >
                    <Home className="w-5 h-5 text-black/60" /> HOME
                  </button>
                  <button
                    onClick={onClose}
                    className="flex-1 bg-[#1C1C1E] py-4 lg:py-5 rounded-full font-bold text-white flex items-center justify-center gap-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)] uppercase text-sm lg:text-lg active:scale-95 transition-all"
                  >
                    NEXT <ChevronRight className="w-5 h-5 text-white/80" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Controls Sidebar side on large screen */}
        {match.status === 'playing' && !revealing && (
          <div className="w-full lg:w-[320px] grid grid-cols-3 lg:grid-cols-2 gap-4 lg:gap-6 lg:self-center flex-shrink-0">
            {NUMBERS.map(n => (
              <motion.button
                key={n}
                whileHover={{ scale: 1.02, y: -2 }}
                whileTap={{ scale: 0.95, y: 4, boxShadow: "0 0px 0 #0f766e" }}
                onClick={() => submitMove(n)}
                disabled={myChoice !== null}
                className={cn(
                  "h-24 lg:h-[148px] rounded-[24px] lg:rounded-[32px] text-4xl lg:text-5xl font-black transition-colors flex items-center justify-center",
                  myChoice === n
                    ? "bg-[#1C1C1E] text-white shadow-lg ring-4 ring-black/10 scale-105"
                    : "bg-white text-black border border-[#E5E5EA] hover:bg-[#F2F2F7] shadow-sm"
                )}
              >
                {n}
              </motion.button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ScoreCard({ player, isBatting, runs, balls, strikeRate, side }: { player: any, isBatting: boolean, runs: number, balls: number, strikeRate: number | string, side: 'left' | 'right' }) {
  return (
    <div className={cn(
      "w-full md:flex-1 flex items-center gap-3 p-3 lg:p-4 rounded-[20px] lg:rounded-[24px] bg-white border-2 transition-all shadow-sm",
      isBatting ? "border-teal-500 ring-4 ring-teal-500/10" : "border-white",
      side === 'right' && "flex-row-reverse text-right"
    )}>
      <div className={cn(
        "w-10 h-10 lg:w-12 lg:h-12 rounded-xl lg:rounded-2xl flex-shrink-0 flex items-center justify-center text-sm lg:text-lg font-black text-white shadow-inner",
        isBatting ? "bg-teal-500" : "bg-slate-200"
      )}>
        {player?.displayName?.[0] || '?'}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[8px] lg:text-[10px] font-black uppercase text-slate-400 leading-none mb-1 truncate tracking-[0.15em]", side === 'right' ? "ml-auto" : "")}>
          {player?.displayName}
        </div>
        <div className={cn("flex flex-wrap items-end gap-3", side === 'right' ? "flex-row-reverse" : "flex-row")}>
            <div className="text-xl lg:text-2xl font-black text-slate-800 tracking-tighter flex flex-shrink-0 items-center gap-1.5 leading-none">
               {runs} <span className="text-[10px] lg:text-[12px] text-teal-600 font-extrabold tracking-tight">RUNS</span>
               {isBatting && <div className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-orange-500 animate-pulse ml-0.5" />}
            </div>

            <div className={cn("flex gap-2 mb-0.5 mt-1 lg:mt-0", side === 'right' && "flex-row-reverse")}>
              <div className={cn("flex flex-col border-slate-100", side === 'right' ? "border-r pr-2 items-end" : "border-l pl-2 items-start")}>
                <span className="text-[7px] text-slate-400 font-bold uppercase tracking-wider leading-none mb-0.5">Balls</span>
                <span className="text-[10px] lg:text-xs font-black text-slate-600 leading-none">{balls}<span className="text-[8px] text-slate-400">/6</span></span>
              </div>
              <div className={cn("flex flex-col border-slate-100", side === 'right' ? "border-r pr-2 items-end" : "border-l pl-2 items-start")}>
                <span className="text-[7px] text-slate-400 font-bold uppercase tracking-wider leading-none mb-0.5">SR</span>
                <span className="text-[10px] lg:text-xs font-black text-slate-600 leading-none">{strikeRate}</span>
              </div>
            </div>
        </div>
      </div>
    </div>
  );
}

function Hand({ value, side, color, label }: { value: number | null, side: 'left' | 'right', color: 'teal' | 'slate', label?: string }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="text-[10px] lg:text-[12px] font-black text-slate-400 uppercase tracking-[0.2em] truncate max-w-[120px]">{label}</div>
      <motion.div
        key={value || 'empty'}
        initial={{ scale: 0.8, y: 15 }}
        animate={{ scale: 1, y: 0 }}
        className={cn(
          "w-28 h-28 lg:w-40 lg:h-40 rounded-[32px] lg:rounded-[48px] flex items-center justify-center border-4 lg:border-8 relative shadow-2xl transition-all",
          color === 'teal' ? "bg-teal-500 border-white text-white" : "bg-slate-800 border-white text-white"
        )}
      >
        <div className="text-5xl lg:text-7xl font-black">
          {value === 0 ? '❌' : (value !== null ? value : '?')}
        </div>

        <div className={cn(
          "absolute -bottom-2 w-14 h-4 lg:w-20 lg:h-6 rounded-full opacity-30 shadow-inner",
          color === 'teal' ? "bg-teal-400" : "bg-slate-700"
        )} />
      </motion.div>
    </div>
  );
}
