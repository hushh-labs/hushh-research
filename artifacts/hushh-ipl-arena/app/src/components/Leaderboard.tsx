import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Trophy, Medal, Star, ArrowLeft, Clock } from 'lucide-react';
import { collection, query, orderBy, limit, getDocs, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile } from '../types';
import { cn } from '../lib/utils';
import { audio } from '../lib/audioManager';

interface LeaderboardProps {
  onClose: () => void;
  currentUser: UserProfile;
}

export default function Leaderboard({ onClose, currentUser }: LeaderboardProps) {
  const [leaders, setLeaders] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeContext, setTimeContext] = useState<'normal' | 'freeze'>('normal');

  useEffect(() => {
    const q = query(collection(db, 'users'), orderBy('xp', 'desc'), limit(15));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => doc.data() as UserProfile);
      setLeaders(data);
      setLoading(false);
    }, (err) => {
      console.error("Failed to fetch leaderboard", err);
      setLoading(false);
    });

    // Check time condition (11:59 PM freeze) in IST
    const checkTime = () => {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: 'numeric', minute: 'numeric' });
      const parts = formatter.formatToParts(now);
      let hours = 0;
      let mins = 0;
      parts.forEach(part => {
          if (part.type === 'hour') hours = parseInt(part.value, 10);
          if (part.type === 'minute') mins = parseInt(part.value, 10);
      });
      if (hours === 24) hours = 0;

      // Freeze from 11:59 PM to 12:44 AM (next 45 min)
      if ((hours === 23 && mins >= 59) || (hours === 0 && mins < 45)) {
        setTimeContext('freeze');
      } else {
        setTimeContext('normal');
      }
    };

    checkTime();
    const interval = setInterval(checkTime, 60000); // Check every minute
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  const displayedLeaders = timeContext === 'freeze' ? leaders.slice(0, 5) : leaders.slice(0, 10);

  return (
    <div className="flex flex-col h-full relative overflow-hidden" style={{ backgroundColor: 'var(--color-bg-screen)' }}>
      <div className="absolute top-0 inset-x-0 h-48 border-b opacity-50 -z-0" style={{ backgroundColor: 'var(--color-surface-deep)', borderBottomColor: 'var(--color-border)' }} />

      {/* Header */}
      <div className="relative z-10 px-6 pt-12 pb-6 flex items-center justify-between">
        <button
          onClick={() => { audio.playTap(); onClose(); }}
          className="w-12 h-12 rounded-[16px] flex items-center justify-center backdrop-blur-md active:scale-95 transition-all text-white border"
          style={{ backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'var(--color-border-hover)' }}
        >
          <ArrowLeft className="w-6 h-6 text-white" />
        </button>
        <h1 className="cred-heading-page lowercase mb-0 text-white">global rank</h1>
        <div className="w-12 h-12" /> {/* Spacer */}
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center z-10">
          <div className="animate-spin rounded-full h-12 w-12 border-b-4" style={{ borderColor: 'var(--color-text-primary)' }}></div>
        </div>
      ) : (
        <div className="flex-1 px-6 pb-24 overflow-y-auto relative z-10 no-scrollbar">

          {timeContext === 'freeze' && (
            <motion.div
              initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
              className="cred-card flex items-center gap-3 mb-6"
            >
              <Clock className="w-6 h-6 animate-pulse text-[var(--color-text-secondary)]" />
              <div>
                <p className="cred-label text-[var(--color-text-muted)] lowercase">processing drops</p>
                <p className="cred-subheading text-white lowercase">fresh start in a few minutes.</p>
              </div>
            </motion.div>
          )}

          {/* Top 3 Podium */}
          {displayedLeaders.length >= 3 && (
            <div className="flex items-end justify-center mb-12 gap-2 h-48 mt-8">
              {/* Rank 2 */}
              <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.1 }} className="flex flex-col items-center z-10">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-[-12px] z-20 text-lg font-bold text-white border" style={{ backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>2</div>
                <div className="w-24 h-28 rounded-t-[24px] border flex flex-col items-center justify-end pb-4" style={{ backgroundColor: 'var(--color-surface-deep)', borderColor: 'var(--color-border)' }}>
                  <span className="cred-label text-white truncate w-20 text-center">{displayedLeaders[1].displayName}</span>
                  <span className="cred-large-number text-sm">{displayedLeaders[1].xp} XP</span>
                  <span className="cred-label text-[var(--color-text-muted)] mt-0.5">best: {displayedLeaders[1].highestScore || 0}</span>
                </div>
              </motion.div>

              {/* Rank 1 */}
              <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="flex flex-col items-center z-20">
                <Trophy className="w-8 h-8 text-[var(--color-gold)] mb-1 drop-shadow-lg" />
                <div className="w-16 h-16 rounded-xl flex items-center justify-center mb-[-16px] z-20 text-xl font-bold border" style={{ backgroundColor: 'var(--color-gold)', borderColor: 'var(--color-border)' }}>1</div>
                <div className="w-28 h-36 border rounded-t-[28px] shadow-2xl flex flex-col items-center justify-end pb-5" style={{ background: 'linear-gradient(180deg, var(--color-surface-elevated) 0%, var(--color-surface-deep) 100%)', borderColor: 'var(--color-border)' }}>
                  <span className="cred-label text-white truncate w-24 text-center">{displayedLeaders[0].displayName}</span>
                  <span className="cred-large-number text-base text-[var(--color-gold)]">{displayedLeaders[0].xp} XP</span>
                  <span className="cred-label text-[var(--color-text-muted)] mt-0.5">best: {displayedLeaders[0].highestScore || 0}</span>
                </div>
              </motion.div>

              {/* Rank 3 */}
              <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.2 }} className="flex flex-col items-center z-0">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-[-10px] z-20 text-base font-bold text-white border" style={{ backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>3</div>
                <div className="w-24 h-24 rounded-t-[24px] border flex flex-col items-center justify-end pb-3" style={{ backgroundColor: 'var(--color-surface-deep)', borderColor: 'var(--color-border)' }}>
                  <span className="cred-label text-white truncate w-20 text-center">{displayedLeaders[2].displayName}</span>
                  <span className="cred-large-number text-xs">{displayedLeaders[2].xp} XP</span>
                  <span className="cred-label text-[var(--color-text-muted)] mt-0.5">best: {displayedLeaders[2].highestScore || 0}</span>
                </div>
              </motion.div>
            </div>
          )}

          {/* List 4 to N */}
          <div className="flex flex-col gap-3">
            {displayedLeaders.slice(3).map((leader, index) => {
              const rank = index + 4;
              const isMe = leader.uid === currentUser.uid;

              return (
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + index * 0.05 }}
                  key={leader.uid}
                  className={cn(
                    "flex items-center p-4 rounded-[20px] transition-all border",
                    isMe ? "bg-[rgba(255,255,255,0.05)] border-[var(--color-border-active)]" : "bg-[var(--color-surface-elevated)] border-[var(--color-border)]"
                  )}
                >
                  <div className={cn("w-8 flex justify-center mr-2 font-bold text-lg", isMe ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)]")}>
                    {rank}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className={cn("font-bold text-base truncate lowercase", isMe ? "text-white" : "text-white")}>
                      {leader.displayName} {isMe && <span className="cred-label text-black bg-white px-2 py-0.5 rounded ml-1 align-middle">YOU</span>}
                    </p>
                    <p className="cred-label text-[var(--color-text-muted)] uppercase mt-0.5">
                      {leader.team || 'None'} • WR {leader.totalGamesPlayed ? Math.round((leader.totalWins / leader.totalGamesPlayed) * 100) : 0}% • BEST {leader.highestScore || 0}
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="cred-large-number text-lg text-white">{leader.xp}</p>
                    <p className="cred-label text-[var(--color-text-muted)] mt-0">XP</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
