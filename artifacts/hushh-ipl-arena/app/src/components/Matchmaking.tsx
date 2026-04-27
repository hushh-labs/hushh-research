import { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { collection, query, where, getDocs, addDoc, doc, onSnapshot, serverTimestamp, deleteDoc, runTransaction, limit } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrorHandler';
import { db } from '../firebase';
import { UserProfile } from '../types';
import { Loader2, X } from 'lucide-react';

interface MatchmakingProps {
  profile: UserProfile;
  onMatchFound: (id: string) => void;
  onCancel: () => void;
}

export default function Matchmaking({ profile, onMatchFound, onCancel }: MatchmakingProps) {
  const [status, setStatus] = useState<'finding' | 'joining'>('finding');
  const [timer, setTimer] = useState(0);
  const currentMatchId = useRef<string | null>(null);
  const isStartingMatch = useRef(false);

  useEffect(() => {
    let unsubMatch: (() => void) | null = null;

    const findMatch = async () => {
      try {
        const q = query(
          collection(db, 'matches'),
          where('status', '==', 'searching'),
          where('isBotMatch', '==', false),
          limit(8)
        );

        const snapshot = await getDocs(q);
        const candidates = snapshot.docs.filter(d => !d.data().players?.[profile.uid]);

        for (const candidate of candidates) {
          const matchRef = doc(db, 'matches', candidate.id);
          const joined = await runTransaction(db, async (transaction) => {
            const current = await transaction.get(matchRef);
            if (!current.exists()) return false;

            const data = current.data();
            const players = data.players || {};
            if (data.status !== 'searching' || data.isBotMatch || players[profile.uid] || Object.keys(players).length !== 1) {
              return false;
            }

            setStatus('joining');
            transaction.update(matchRef, {
              status: 'toss',
              players: {
                ...players,
                [profile.uid]: {
                  uid: profile.uid,
                  displayName: profile.displayName,
                  team: profile.team
                }
              },
              updatedAt: serverTimestamp()
            });
            return true;
          });

          if (joined) {
            currentMatchId.current = candidate.id;
            onMatchFound(candidate.id);
            return;
          }
        }

        const newMatch = {
          status: 'searching',
          isBotMatch: false,
          players: {
            [profile.uid]: {
              uid: profile.uid,
              displayName: profile.displayName,
              team: profile.team
            }
          },
          currentBatterId: '',
          currentBowlerId: '',
          innings: 1,
          scoreP1: 0,
          scoreP2: 0,
          lastMoves: {},
          history: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };

        const docRef = await addDoc(collection(db, 'matches'), newMatch);
        const matchId = docRef.id;
        currentMatchId.current = matchId;

        // Listen for second player
        unsubMatch = onSnapshot(doc(db, 'matches', matchId), (d) => {
          if (d.exists() && d.data().status === 'toss') {
            onMatchFound(d.id);
          }
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.LIST, 'matches');
      }
    };

    findMatch();

    const interval = setInterval(() => setTimer(t => t + 1), 1000);

    return () => {
      clearInterval(interval);
      if (unsubMatch) unsubMatch();
    };
  }, []);

  useEffect(() => {
    if (timer >= 15) {
      handleStartBot('hard');
    }
  }, [timer]);

  const cleanupMatch = async () => {
    if (currentMatchId.current) {
      try {
        await deleteDoc(doc(db, 'matches', currentMatchId.current));
      } catch (e) {
        console.error('Failed to cleanup match', e);
      }
      currentMatchId.current = null;
    }
  };

  const handleCancel = async () => {
    await cleanupMatch();
    onCancel();
  };

  const handleStartBot = async (difficulty: 'easy' | 'medium' | 'hard') => {
    if (isStartingMatch.current) return;
    isStartingMatch.current = true;
    await cleanupMatch();
    // Start bot match
    const newMatch = {
      status: 'toss',
      isBotMatch: true,
      botDifficulty: difficulty,
      players: {
        [profile.uid]: {
          uid: profile.uid,
          displayName: profile.displayName,
          team: profile.team
        },
        'bot': {
          uid: 'bot',
          displayName: 'hushh bot',
          team: 'hushh'
        }
      },
      currentBatterId: '',
      currentBowlerId: '',
      innings: 1,
      scoreP1: 0,
      scoreP2: 0,
      lastMoves: {},
      history: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    const docRef = await addDoc(collection(db, 'matches'), newMatch);
    onMatchFound(docRef.id);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="w-full flex-1 flex flex-col items-center justify-center p-8"
      style={{ backgroundColor: 'var(--color-bg-screen)' }}
    >
      <div className="relative mb-12">
        <div className="w-32 h-32 rounded-3xl flex items-center justify-center relative overflow-hidden" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
           <div className="absolute inset-0 bg-white/5 animate-pulse" />
           <Loader2 className="w-12 h-12 animate-spin relative z-10" style={{ color: 'var(--color-cta-primary)' }} />
        </div>
        <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-white text-[10px] font-bold px-4 py-1.5 rounded-full shadow-xl whitespace-nowrap z-20 lowercase" style={{ background: 'var(--color-surface-deep)', border: '1px solid var(--color-border)' }}>
           scanning areas...
        </div>
      </div>

      <h2 className="cred-heading-page mb-2 lowercase text-center">searching the arena</h2>

      <div className="px-5 py-2 rounded-full mb-12 flex items-center gap-3" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
        <div className="w-2 h-2 rounded-full bg-[var(--color-success)] animate-pulse" />
        <p className="cred-label" style={{ textTransform: 'lowercase' }}>
          matching from global pool
        </p>
      </div>

      <div className="flex items-center gap-12 mb-16 relative">
        <div className="flex flex-col items-center gap-4">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-3xl font-bold uppercase transition-colors" style={{ background: 'var(--color-surface-deep)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}>
            {profile.displayName[0]}
          </div>
          <span className="cred-label">{profile.displayName}</span>
        </div>

        <div className="text-2xl font-bold tracking-tighter" style={{ color: 'var(--color-text-muted)' }}>VS</div>

        <div className="flex flex-col items-center gap-4">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center border transition-colors animate-pulse" style={{ background: 'transparent', borderColor: 'var(--color-border)' }}>
            <span className="text-3xl font-bold" style={{ color: 'var(--color-border)' }}>?</span>
          </div>
          <span className="cred-label" style={{ color: 'var(--color-text-muted)' }}>scouting...</span>
        </div>
      </div>

      <div className="flex flex-col w-full max-w-sm gap-2">
        <div className="text-center mb-2">
          <p className="cred-label" style={{ textTransform: 'lowercase' }}>
            {status === 'joining'
              ? 'locking opponent...'
              : 15 - timer > 0 ? `auto-match with hushh bot in ${15 - timer}s...` : 'starting match with hushh bot...'}
          </p>
        </div>

        {timer >= 5 && (
          <div className="flex flex-col items-center gap-3 w-full p-4 rounded-2xl mb-4" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
             <span className="cred-label mb-1" style={{ textTransform: 'lowercase' }}>play vs ai (select difficulty)</span>
             <div className="flex gap-2 w-full">
                <motion.button
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  onClick={() => handleStartBot('easy')}
                  className="flex-1 cred-cta-secondary h-10"
                >
                  easy
                </motion.button>
                <motion.button
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.1 }}
                  onClick={() => handleStartBot('medium')}
                  className="flex-1 cred-cta-secondary h-10"
                >
                  med
                </motion.button>
                <motion.button
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                  onClick={() => handleStartBot('hard')}
                  className="flex-1 cred-cta-primary h-10"
                >
                  hard
                </motion.button>
             </div>
          </div>
        )}

        <button
          onClick={handleCancel}
          className="cred-cta-secondary bg-transparent border-none !shadow-none !text-[var(--color-text-muted)] hover:!text-[var(--color-text-primary)]"
        >
          <X className="w-5 h-5" />
          abort launch
        </button>
      </div>
    </motion.div>
  );
}
