import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { MatchData, UserProfile } from '../types';
import { cn } from '../lib/utils';
import { getPlayerOrder } from '../lib/rankedBattle';
import { ChevronLeft, Play, Pause, SkipForward, SkipBack } from 'lucide-react';
import { audio } from '../lib/audioManager';

interface ReplayProps {
  matchId: string;
  profile: UserProfile;
  onBack: () => void;
}

export default function MatchReplay({ matchId, profile, onBack }: ReplayProps) {
  const [matchData, setMatchData] = useState<MatchData | null>(null);
  const [loading, setLoading] = useState(true);

  const [moveIndex, setMoveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    async function loadMatch() {
      try {
        const d = await getDoc(doc(db, 'matches', matchId));
        if (d.exists()) {
          setMatchData(d.data() as MatchData);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    loadMatch();
  }, [matchId]);

  useEffect(() => {
    let timer: any;
    if (isPlaying && matchData) {
      if (moveIndex < matchData.history.length) {
        timer = setTimeout(() => {
          setMoveIndex(i => i + 1);
          audio.playTap();
        }, 1500);
      } else {
        setIsPlaying(false);
      }
    }
    return () => clearTimeout(timer);
  }, [isPlaying, moveIndex, matchData]);

  if (loading) {
     return <div className="flex-1 flex items-center justify-center font-black text-slate-400 uppercase tracking-widest">Loading Replay...</div>;
  }

  if (!matchData) {
     return <div className="flex-1 flex flex-col items-center justify-center font-black text-slate-400 uppercase tracking-widest gap-4">
       Match not found
       <button onClick={onBack} className="bg-slate-200 text-slate-600 px-4 py-2 rounded-xl text-xs">Go Back</button>
     </div>;
  }

  // Reconstruct state at current moveIndex
  const pids = getPlayerOrder(matchData);
  let scoreP1 = 0;
  let scoreP2 = 0;
  let ballsP1 = 0;
  let ballsP2 = 0;
  let currentInnings = 1;
  let currentBatterId = matchData.tossWinnerId || pids[0];
  let currentBowlerId = pids.find(id => id !== currentBatterId)!;

  const history = matchData.history.slice(0, moveIndex);

  let lastMove = history.length > 0 ? history[history.length - 1] : null;

  for (const move of history) {
    if (move.batterId === pids[0]) {
      ballsP1++;
    } else {
      ballsP2++;
    }

    if (move.bat === 0 || move.bowl === 0) {
      // Dot ball - zero runs, no wicket
    } else if (move.bat === move.bowl) {
      if (currentInnings === 1) {
        currentInnings = 2;
        currentBatterId = currentBowlerId;
        currentBowlerId = move.batterId; // swap
      }
    } else {
      if (move.batterId === pids[0]) {
        scoreP1 += move.bat;
      } else {
        scoreP2 += move.bat;
      }
    }
  }

  const p1 = matchData.players[pids[0]];
  const p2 = matchData.players[pids[1]];

  const srP1 = ballsP1 > 0 ? ((scoreP1 / ballsP1) * 100).toFixed(0) : 0;
  const srP2 = ballsP2 > 0 ? ((scoreP2 / ballsP2) * 100).toFixed(0) : 0;

  return (
    <div className="w-full flex-1 flex flex-col pt-12 pb-8 px-4 lg:px-12 bg-slate-900 border-x-4 border-slate-950">
      <div className="w-full max-w-5xl mx-auto flex items-center justify-between pointer-events-auto z-10 mb-8 relative">
        <button
          onClick={onBack}
          className="w-12 h-12 bg-[#F2F2F7] rounded-full text-black flex items-center justify-center shadow-sm active:scale-95 transition-all"
        >
          <ChevronLeft className="w-6 h-6" strokeWidth={3} />
        </button>
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
            <span className="text-xs font-black text-red-500 tracking-[0.2em]">REPLAY</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 mb-12 max-w-5xl mx-auto w-full">
        <ScoreCard
          player={p1}
          isBatting={currentBatterId === pids[0]}
          runs={scoreP1}
          balls={ballsP1}
          sr={srP1}
          side="left"
        />
        <div className="flex flex-col items-center flex-shrink-0">
             <div className="bg-slate-700 text-[10px] font-black px-3 py-1 rounded mb-1 text-white uppercase tracking-[0.2em] leading-none">VS</div>
             <div className="bg-slate-800 px-3 py-1 rounded-full text-[10px] font-black text-slate-400 uppercase tracking-widest border border-slate-700">
               {currentInnings === 1 ? 'INN 1' : 'TGT: ' + (pids[0] === currentBatterId ? (scoreP2 + 1) : (scoreP1 + 1))}
             </div>
        </div>
        <ScoreCard
          player={p2}
          isBatting={currentBatterId === pids[1]}
          runs={scoreP2}
          balls={ballsP2}
          sr={srP2}
          side="right"
        />
      </div>

      <div className="flex-1 max-w-xl mx-auto w-full bg-slate-800/50 rounded-[40px] border border-slate-700 flex flex-col items-center justify-center p-8 relative overflow-hidden">
        {lastMove ? (
          <AnimatePresence mode="wait">
            <motion.div
              key={moveIndex}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 1.1, opacity: 0 }}
              className="flex flex-col items-center"
            >
              <div className="flex gap-12 items-center mb-8">
                <div className="flex flex-col items-center">
                  <span className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4">BAT</span>
                  <div className="w-24 h-24 bg-slate-700 rounded-3xl flex items-center justify-center text-5xl font-black text-white shadow-inner">
                    {lastMove.bat === 0 ? '❌' : lastMove.bat}
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  <span className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4">BOWL</span>
                  <div className="w-24 h-24 bg-slate-700 rounded-3xl flex items-center justify-center text-5xl font-black text-white shadow-inner">
                    {lastMove.bowl === 0 ? '❌' : lastMove.bowl}
                  </div>
                </div>
              </div>

              {lastMove.bat === 0 || lastMove.bowl === 0 ? (
                <div className="text-3xl font-black text-yellow-500 tracking-wider">TIMEOUT (0 RUNS)</div>
              ) : lastMove.bat === lastMove.bowl ? (
                <div className="text-4xl font-black text-red-500 tracking-tighter uppercase drop-shadow-lg scale-110 animate-pulse">
                  OUT!
                </div>
              ) : (
                <div className="text-3xl font-black text-teal-400 tracking-wider">+ {lastMove.bat} RUNS</div>
              )}
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="text-slate-500 font-black tracking-widest uppercase text-sm">
            Press Play to start
          </div>
        )}
      </div>

      <div className="max-w-md mx-auto w-full mt-8 bg-slate-800 p-4 rounded-3xl border border-slate-700 flex flex-col items-center gap-4">
         <div className="w-full flex items-center gap-2">
            <span className="text-[10px] font-black text-slate-500 font-mono w-4">{moveIndex}</span>
            <div className="flex-1 h-3 bg-slate-900 rounded-full overflow-hidden relative">
               <motion.div
                  className="absolute top-0 left-0 h-full bg-teal-500"
                  initial={{ width: 0 }}
                  animate={{ width: `${(moveIndex / Math.max(matchData.history.length, 1)) * 100}%` }}
               />
            </div>
            <span className="text-[10px] font-black text-slate-500 font-mono w-4">{matchData.history.length}</span>
         </div>
         <div className="flex items-center gap-6 text-slate-400">
           <button
             onClick={() => { audio.playTap(); setMoveIndex(Math.max(0, moveIndex - 1)); }}
             disabled={moveIndex === 0}
             className="p-3 bg-slate-900 rounded-2xl disabled:opacity-30 active:scale-95"
           >
             <SkipBack className="w-5 h-5 fill-current" />
           </button>
           <button
             onClick={() => { audio.playTap(); setIsPlaying(!isPlaying); }}
             className="p-4 bg-[#1C1C1E] text-white rounded-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all"
           >
             {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current ml-1" />}
           </button>
           <button
             onClick={() => { audio.playTap(); setMoveIndex(Math.min(matchData.history.length, moveIndex + 1)); }}
             disabled={moveIndex === matchData.history.length}
             className="p-3 bg-slate-900 rounded-2xl disabled:opacity-30 active:scale-95"
           >
             <SkipForward className="w-5 h-5 fill-current" />
           </button>
         </div>
      </div>
    </div>
  );
}

function ScoreCard({ player, isBatting, runs, balls, sr, side }: { player: any, isBatting: boolean, runs: number, balls: number, sr: number | string, side: 'left' | 'right' }) {
  return (
    <div className={cn("flex items-center gap-4 flex-1", side === 'right' ? "flex-row-reverse" : "")}>
      <div className="w-16 h-16 rounded-[20px] bg-slate-800 border-2 border-slate-700 flex items-center justify-center flex-shrink-0 relative">
        <span className="text-2xl font-black text-slate-400">{player?.displayName?.[0]?.toUpperCase()}</span>
        {isBatting && (
          <div className={cn("absolute -top-2 w-6 h-6 bg-yellow-400 rounded-full border-2 border-slate-900 shadow-sm flex items-center justify-center", side === 'right' ? "-right-2" : "-left-2")}>
            <span className="text-[10px]">🏏</span>
          </div>
        )}
      </div>
      <div className={cn("flex flex-col min-w-0 flex-1", side === 'right' ? "items-end text-right" : "items-start text-left")}>
        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest truncate max-w-[100%]">{player?.displayName || 'Player'}</h3>
        <div className={cn("flex items-baseline gap-3 mt-0.5 w-full", side === 'right' ? "flex-row-reverse" : "")}>
          <div className="flex items-baseline gap-1.5 flex-shrink-0">
            <span className="text-3xl font-black text-white leading-none tracking-tighter">{runs}</span>
            <span className="text-xs font-bold text-teal-500 tracking-widest uppercase">Runs</span>
          </div>
          <div className={cn("flex gap-2 mb-0.5", side === 'right' && "flex-row-reverse")}>
            <div className={cn("flex flex-col border-slate-700", side === 'right' ? "border-r pr-2 items-end" : "border-l pl-2 items-start")}>
              <span className="text-[7px] text-slate-500 font-bold uppercase tracking-wider leading-none mb-0.5">Balls</span>
              <span className="text-[10px] font-black text-slate-300 leading-none">{balls}</span>
            </div>
            <div className={cn("flex flex-col border-slate-700", side === 'right' ? "border-r pr-2 items-end" : "border-l pl-2 items-start")}>
              <span className="text-[7px] text-slate-500 font-bold uppercase tracking-wider leading-none mb-0.5">SR</span>
              <span className="text-[10px] font-black text-slate-300 leading-none">{sr}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
