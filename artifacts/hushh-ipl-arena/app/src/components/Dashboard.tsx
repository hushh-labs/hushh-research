import { motion, AnimatePresence } from 'motion/react';
import { UserProfile } from '../types';
import { Trophy, Clock, Zap, PlayCircle, Dumbbell, Award, Timer, Bell, Gift, LogOut, Star, RotateCcw, BarChart2, Users, Activity, Map } from 'lucide-react';
import { logout, db } from '../firebase';
import { cn } from '../lib/utils';
import { useState, useEffect } from 'react';
import { doc, updateDoc, increment, serverTimestamp, getCountFromServer, getAggregateFromServer, sum, collection, query, where, onSnapshot, orderBy, limit } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrorHandler';
import { getArenaUpdate, ArenaEvent, getCpaInsight } from '../services/geminiService';

interface DashboardProps {
  profile: UserProfile;
  onPlay: () => void;
  onPractice: (difficulty: 'easy' | 'medium' | 'hard') => void;
  onReplayMatch?: (matchId: string) => void;
  onOpenLeaderboard: () => void;
}

export default function Dashboard({ profile, onPlay, onPractice, onReplayMatch, onOpenLeaderboard }: DashboardProps) {
  const gamesLeft = 5 - (profile.gamesPlayed24h || 0);
  const botGamesLeft = 3 - (profile.botGamesPlayed24h || 0);

  const [liveActivity, setLiveActivity] = useState<{city: string, text: string, time: string}[]>([]);
  const [notifications, setNotifications] = useState<{ id: string, text: string, type: 'reward' | 'info' | 'battle' }[]>([]);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showPracticeDifficulties, setShowPracticeDifficulties] = useState(false);
  const [scoutsCount, setScoutsCount] = useState(6240);
  const [cpaStats, setCpaStats] = useState({
    activeMatches: 0,
    totalXpGiven: 0,
    newPlayersToday: 0,
  });
  const [insight, setInsight] = useState("Analyzing arena activity...");
  const [leaderboardNudge, setLeaderboardNudge] = useState<string | null>(null);

  const [timeUntilNextClaim, setTimeUntilNextClaim] = useState<string | null>(null);

  useEffect(() => {
    if (!profile.lastClaimedReward) return;

    const updateCountdown = () => {
      const lastDate = profile.lastClaimedReward?.toDate ? profile.lastClaimedReward.toDate() : new Date(profile.lastClaimedReward);
      const diff = lastDate.getTime() + 24 * 60 * 60 * 1000 - new Date().getTime();

      if (diff <= 0) {
        setTimeUntilNextClaim(null);
      } else {
        const h = Math.floor(diff / (1000 * 60 * 60));
        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const s = Math.floor((diff % (1000 * 60)) / 1000);
        setTimeUntilNextClaim(`${h}h ${m}m ${s}s`);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [profile.lastClaimedReward]);

  // Gamification: Daily Rewards
  const canClaimDaily = !profile.lastClaimedReward ||
    (() => {
      const lastDate = profile.lastClaimedReward?.toDate ? profile.lastClaimedReward.toDate() : new Date(profile.lastClaimedReward);
      return new Date().getTime() - lastDate.getTime() >= 24 * 60 * 60 * 1000;
    })();

  const handleClaimReward = async () => {
    if (!canClaimDaily) return;
    const path = `users/${profile.uid}`;
    try {
      const userRef = doc(db, 'users', profile.uid);
      await updateDoc(userRef, {
        lastClaimedReward: serverTimestamp(),
        xp: increment(100),
        streak: increment(1)
      });
      addNotification("Daily reward claimed! +100 XP", 'reward');
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, path);
    }
  };

  const addNotification = (text: string, type: 'reward' | 'info' | 'battle' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setNotifications(prev => [{ id, text, type }, ...prev].slice(0, 3));
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 5000);
  };

  useEffect(() => {
    const updateArena = async () => {
      try {
        const event = await getArenaUpdate();

        setLiveActivity(prev => [{
          city: event.city,
          text: event.text,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        }, ...prev].slice(0, 15));

        // Smart notifications based on event type
        if (Math.random() > 0.7) {
          let noteType: 'reward' | 'info' | 'battle' = 'info';
          if (event.type === 'win' || event.type === 'streak') noteType = 'battle';
          addNotification(event.text, noteType);
        }
      } catch (e) {
         // Silently handle API failures for AI events
      }
    };

    // Real-time CPA Stats & Scouts
    const fetchRealStats = async () => {
      try {
        // Active matches
        const qMatches = query(collection(db, 'matches'), where('status', 'in', ['searching', 'toss', 'playing']));
        const matchesSnap = await getCountFromServer(qMatches);
        const activeMatchesCount = matchesSnap.data().count;

        // Total Users -> New Signups (simulation based on total diff, or just show total users to be more engaging)
        const playersSnap = await getCountFromServer(collection(db, 'users'));
        const totalPlayers = playersSnap.data().count;

        // Total XP Given
        const xpSnap = await getAggregateFromServer(collection(db, 'users'), {
          totalXp: sum('xp')
        });
        const totalXp = xpSnap.data().totalXp || 0;

        const newStats = {
          activeMatches: activeMatchesCount,
          totalXpGiven: totalXp,
          newPlayersToday: totalPlayers
        };
        setCpaStats(newStats);

        // Fetch AI Insight
        const newInsight = await getCpaInsight(newStats);
        setInsight(newInsight);
      } catch (err) {
        console.error("Failed to fetch CPA real stats", err);
      }
    };

    // Simulate live look-ins visually based on active matches
    // Top 5 Leaderboard Nudge Listener
    let previousTop5: any[] = [];
    const qTop5 = query(collection(db, 'users'), orderBy('xp', 'desc'), limit(5));
    const unsubTop5 = onSnapshot(qTop5, (snapshot) => {
      const currentTop5 = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));

      if (previousTop5.length > 0) {
          const previousTop5Ids = previousTop5.map(u => u.id);
          const newEntries = currentTop5.filter(u => !previousTop5Ids.includes(u.id));

          if (newEntries.length > 0) {
             const newPlayer = newEntries[0];
             setLeaderboardNudge(`${newPlayer.displayName || 'A player'} just entered the Top 5! 🔥`);
             setTimeout(() => setLeaderboardNudge(null), 5000);
          } else {
             for (let i = 0; i < currentTop5.length; i++) {
                 const curr: any = currentTop5[i];
                 const prev: any = previousTop5.find(p => p.id === curr.id);
                 if (prev && curr.xp - prev.xp >= 30) {
                     setLeaderboardNudge(`Massive gain! ${curr.displayName} is charging up! 🚀`);
                     setTimeout(() => setLeaderboardNudge(null), 5000);
                     break;
                 }
             }
          }
      }
      previousTop5 = currentTop5;
    });

    const fastInterval = setInterval(() => {
      setScoutsCount(prev => {
        const change = Math.floor(Math.random() * 11) - 4;
        return Math.max(10, prev + change);
      });
    }, 2500);

    fetchRealStats();
    const statsInterval = setInterval(fetchRealStats, 30000); // Poll every 30s for stats

    // Initial load
    updateArena();

    // AI Activity generator
    const activityInterval = setInterval(updateArena, 8000);

    return () => {
      clearInterval(fastInterval);
      clearInterval(activityInterval);
      clearInterval(statsInterval);
      unsubTop5();
    };
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="w-full flex-1 flex flex-col lg:flex-row gap-4 lg:gap-8 p-4 lg:p-12 pb-24 lg:pb-12 overflow-y-auto lg:overflow-visible scrollbar-none relative text-[#F4F4F5]"
      style={{ backgroundColor: 'var(--color-bg-screen)' }}
    >
      {/* Notification Toast Layer */}
      <div className="fixed top-8 right-8 z-[100] flex flex-col gap-3 w-72 pointer-events-none">
        <AnimatePresence>
          {notifications.map(n => (
            <motion.div
              key={n.id}
              initial={{ x: 50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 50, opacity: 0 }}
              className={cn(
                "p-4 rounded-2xl shadow-2xl border-2 flex items-center gap-3 backdrop-blur-md",
                n.type === 'reward' ? "bg-black text-white border-black" : "bg-white border-black border text-black"
              )}
            >
              {n.type === 'reward' ? <Gift className="w-5 h-5 text-[#FF2D55]" /> : <Bell className="w-5 h-5 text-[#FFCC00]" />}
              <span className="font-black uppercase text-[10px] tracking-widest">{n.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Left / Main Profile Area */}
      <div className="flex-1 flex flex-col max-w-3xl mx-auto w-full lg:mx-0 lg:max-w-none">
        {/* Top Bar */}
        <div className="flex items-center justify-between mt-0 lg:mt-4 mb-10 bg-transparent">
          <div>
             <h3 className="text-xl leading-tight lowercase font-medium" style={{ color: 'var(--color-text-secondary)' }}>good evening, {profile.displayName.split(' ')[0]}</h3>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onOpenLeaderboard}
              className="cred-icon-container text-[var(--color-text-primary)] transition-colors"
            >
              <Trophy className="w-5 h-5" />
            </button>
            <button
              onClick={() => setShowLogoutConfirm(true)}
              className="w-11 h-11 rounded-xl flex items-center justify-center text-lg font-bold uppercase transition-colors"
              style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
            >
              {profile.displayName[0]}
            </button>
          </div>
        </div>

        {/* Hero Section */}
        <div className="mb-8">
          <div className="cred-label mb-2">MEMBER DASHBOARD</div>
          <h2 className="cred-heading-hero mb-3 lowercase">play smarter</h2>
          <p className="cred-subheading lowercase">track your games, win rewards, and climb the ranks in one premium view.</p>
        </div>

        {/* Hero Card / Level Progress */}
        <div className="cred-card mb-6">
           <div className="flex justify-between items-center mb-3">
             <span className="cred-label">SCOUT EXPERIENCE</span>
             <span className="cred-label" style={{ color: 'var(--color-text-primary)' }}>{(profile.xp || 0) % 1000} / 1000 XP</span>
           </div>
           <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: 'var(--color-surface-deep)' }}>
             <motion.div
               initial={{ width: 0 }}
               animate={{ width: `${((profile.xp || 0) % 1000) / 10}%` }}
               className="h-full"
               style={{ background: 'var(--color-cta-primary)' }}
             />
           </div>
           <div className="mt-4 flex items-center gap-2">
              <div className="px-2 py-1 rounded shadow-sm" style={{ background: 'var(--color-surface-deep)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px' }}>
                LEVEL {Math.floor((profile.xp || 0) / 1000) + 1}
              </div>
           </div>
        </div>

        {/* Career Stats */}
        <div className="cred-card mb-6 grid grid-cols-3 gap-2 text-center">
          <div>
            <span className="cred-label block mb-2">WIN RATE</span>
            <div className="cred-large-number">{profile.totalGamesPlayed ? Math.round((profile.totalWins / profile.totalGamesPlayed) * 100) : 0}%</div>
            <div className="cred-label mt-2" style={{ textTransform: 'lowercase' }}>{profile.totalWins}w - {(profile.totalGamesPlayed || 0) - profile.totalWins}l</div>
          </div>
          <div style={{ borderLeft: '1px solid var(--color-border)', borderRight: '1px solid var(--color-border)' }}>
            <span className="cred-label block mb-2">AVG RUNS</span>
            <div className="cred-large-number">{profile.totalGamesPlayed ? Math.round(profile.totalRuns / profile.totalGamesPlayed) : 0}</div>
            <div className="cred-label mt-2" style={{ textTransform: 'lowercase' }}>{profile.totalGamesPlayed || 0} games</div>
          </div>
          <div>
            <span className="cred-label block mb-2">BEST SCORE</span>
            <div className="cred-large-number">{profile.highestScore || 0}</div>
            <div className="cred-label mt-2" style={{ textTransform: 'lowercase' }}>all time</div>
          </div>
        </div>

        {/* Leaderboard Nudge Box */}
        <div className="relative mb-8 z-10 w-full">
           <div
             onClick={onOpenLeaderboard}
             className="bg-white rounded-[32px] p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 cursor-pointer hover:shadow-lg transition-all border border-[#E5E5EA] shadow-[0_8px_30px_rgb(0,0,0,0.04)]"
           >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 sm:w-12 sm:h-12 flex-shrink-0 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-sm">
                  <Trophy className="w-5 h-5 sm:w-6 sm:h-6 text-[#FFCC00]" />
                </div>
                <div>
                  <h3 className="text-black font-black uppercase tracking-widest mb-1 text-xs sm:text-sm">Global Leaderboard</h3>
                  <p className="text-black/60 font-bold uppercase text-[9px] sm:text-[10px] tracking-wider leading-tight">Top 5 players by 11:59 PM unlock exclusive rewards</p>
                </div>
              </div>
              <div className="w-full sm:w-auto flex items-center justify-center gap-2 bg-[#F2F2F7] px-3 py-2 sm:py-1.5 rounded-full text-black text-[10px] font-black uppercase tracking-widest">
                View Ranks <Star className="w-3 h-3 fill-[#FFCC00] text-[#FFCC00]" />
              </div>
           </div>

           <AnimatePresence>
             {leaderboardNudge && (
               <motion.div
                 initial={{ opacity: 0, y: -20, scale: 0.95 }}
                 animate={{ opacity: 1, y: 12, scale: 1 }}
                 exit={{ opacity: 0, y: -10, scale: 0.95 }}
                 className="absolute -bottom-10 left-1/2 -translate-x-1/2 bg-black border border-white/20 text-white px-5 py-2.5 rounded-full shadow-2xl flex items-center gap-2 whitespace-nowrap z-20 pointer-events-none"
               >
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                  <span className="text-[10px] uppercase font-black tracking-widest">{leaderboardNudge}</span>
               </motion.div>
             )}
           </AnimatePresence>
        </div>

        {/* Stats and Action Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6 mb-8 items-stretch">
          <div className="flex flex-col gap-4">
            {/* Daily Incentive */}
            <div
              onClick={handleClaimReward}
              className={cn(
                "rounded-2xl p-5 lg:p-6 transition-all relative overflow-hidden group border",
                canClaimDaily
                  ? "cursor-pointer border-[var(--color-gold)] shadow-[0_16px_40px_rgba(215,181,109,0.22)]"
                  : "cursor-default border-[var(--color-border)] opacity-60",
              )}
              style={canClaimDaily ? { background: 'linear-gradient(135deg, var(--color-gold) 0%, #8F6F2F 100%)' } : { background: 'var(--color-surface-elevated)' }}
            >
               <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 relative z-10 w-full">
                <div className="flex-1 w-full min-w-0">
                   <h4 className="cred-label mb-1 truncate" style={{ color: canClaimDaily ? 'rgba(0,0,0,0.6)' : 'var(--color-text-muted)' }}>DAILY TRAINING</h4>
                   <p className="font-mono text-xl sm:text-2xl font-bold tracking-tighter truncate w-full" style={{ color: canClaimDaily ? '#000000' : 'var(--color-text-primary)' }}>
                     {canClaimDaily ? "CLAIM 100 XP" : (timeUntilNextClaim ? `READY IN ${timeUntilNextClaim}` : "TRAINED TODAY")}
                   </p>
                </div>
                <div className={cn(
                  "w-12 h-12 rounded-xl flex items-center justify-center shrink-0",
                  canClaimDaily ? "bg-black/10 text-black" : "bg-white/5 text-white/40"
                )}>
                  <Gift className="w-6 h-6" />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="cred-small-card flex flex-col justify-center items-center text-center">
                <span className="cred-label block mb-2">STREAK</span>
                <div className="flex items-center gap-1.5">
                   <div className="cred-large-number">{profile.streak || 0}</div>
                   <Zap className={cn("w-5 h-5 transition-all", (profile.streak || 0) > 0 ? "fill-[var(--color-warning)] text-[var(--color-warning)]" : "text-[var(--color-text-disabled)]")} />
                </div>
              </div>
              <div className="cred-small-card flex flex-col justify-center items-center text-center">
                <span className="cred-label block mb-2">RANKED</span>
                <div className="cred-large-number">{gamesLeft} <span className="text-xl text-[var(--color-text-muted)]">/ 5</span></div>
              </div>
            </div>

            <div className="flex flex-col gap-3 h-full justify-end mt-4">
              <div className="relative">
                <button
                  onClick={onPlay}
                  disabled={gamesLeft <= 0}
                  className="cred-cta-primary disabled:opacity-50 disabled:grayscale"
                >
                  <PlayCircle className="w-5 h-5" />
                  ranked battle
                </button>
              </div>
              <div className="text-center cred-label my-1 py-1">
                1-Over Blitz • 6 Balls / Innings
              </div>

              {!showPracticeDifficulties ? (
                <button
                  onClick={() => setShowPracticeDifficulties(true)}
                  className="cred-cta-secondary"
                >
                  <Dumbbell className="w-5 h-5" />
                  practice
                </button>
              ) : (
                <div className="cred-small-card border border-[var(--color-border-active)]">
                   <span className="cred-label block text-center mb-3">SELECT DIFFICULTY</span>
                   <div className="flex gap-2">
                      <button onClick={() => onPractice('easy')} className="flex-1 cred-cta-secondary h-10">easy</button>
                      <button onClick={() => onPractice('medium')} className="flex-1 cred-cta-secondary h-10">med</button>
                      <button onClick={() => onPractice('hard')} className="flex-1 cred-cta-primary h-10">hard</button>
                   </div>
                </div>
              )}

              {profile.lastMatchId && (
              <button
                onClick={() => onReplayMatch?.(profile.lastMatchId!)}
                className="cred-cta-secondary bg-transparent !text-[var(--color-text-secondary)] border-none mt-2 !shadow-none"
              >
                <RotateCcw className="w-4 h-4" />
                replay last match
              </button>
              )}
            </div>
          </div>

          <div className="cred-card flex flex-col justify-between h-full" style={{ background: 'linear-gradient(135deg, var(--color-purple) 0%, #25105F 100%)', border: 'none', position: 'relative', overflow: 'hidden' }}>
            <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full -mr-24 -mt-24 blur-3xl pointer-events-none" />

            <div className="relative z-10">
              <h3 className="cred-heading-card mb-6 flex items-center gap-3 lowercase">
                <Award className="w-6 h-6 text-white" /> season rewards
              </h3>
              <div className="space-y-4">
                {[
                  { label: 'Smart Watch', icon: '⌚', desc: 'Top Scorer of the Week' },
                  { label: 'Swiggy Voucher', icon: '🥡', desc: 'Daily 5-Match Streak' },
                ].map((item) => (
                  <div key={item.label} className="p-4 rounded-2xl flex items-center gap-4 border" style={{ background: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.1)' }}>
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-lg bg-white/10 text-white backdrop-blur-md">
                      {item.icon}
                    </div>
                    <div>
                      <p className="font-bold text-white leading-tight lowercase">{item.label}</p>
                      <p className="cred-label mt-1 text-white/60">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-8 pt-6 border-t flex justify-between items-center relative z-10" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div className="flex flex-col">
                <span className="cred-label text-white/60">NEXT REWARD DROP</span>
                <span className="cred-large-number text-white text-xl mt-1">11:59 PM IST</span>
              </div>
            </div>
          </div>
        </div>

        {/* Development Roadmap */}
        <div className="cred-card mb-8">
          <h3 className="cred-heading-card mb-6 flex items-center gap-3 lowercase">
            <Map className="w-5 h-5 text-[var(--color-text-secondary)]" /> community roadmap
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { phase: 'Q2 2026', title: 'Global Settings', desc: 'Cross-border matching', status: 'live' },
              { phase: 'Q3 2026', title: 'Hand Cricket Crews', desc: 'Form crews & share XP', status: 'next' },
              { phase: 'Q4 2026', title: 'World Cup Mode', desc: '16-player brackets', status: 'soon' }
            ].map((item, idx) => (
              <div key={idx} className={cn(
                "p-5 rounded-2xl border transition-all",
                item.status === 'live' ? "bg-[rgba(255,255,255,0.05)] border-[var(--color-border-active)]" : "bg-[var(--color-surface-elevated)] border-[var(--color-border)]"
              )}>
                <div className="flex justify-between items-center mb-3">
                  <span className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest",
                    item.status === 'live' ? "bg-white text-black" : "bg-black/20 text-[var(--color-text-secondary)]"
                  )}>{item.phase}</span>
                  {item.status === 'live' && <span className="flex items-center gap-1 text-[9px] font-bold text-white uppercase tracking-widest"><div className="w-1.5 h-1.5 bg-[var(--color-warning)] rounded-full animate-pulse"/> Live</span>}
                </div>
                <h4 className="font-bold text-white leading-tight mb-1">{item.title}</h4>
                <p className="cred-label" style={{ color: 'var(--color-text-muted)', textTransform: 'lowercase' }}>{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      <AnimatePresence>
        {showLogoutConfirm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-6"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(8px)' }}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              className="cred-card max-w-sm w-full text-center"
            >
              <div className="w-16 h-16 rounded-xl flex items-center justify-center mx-auto mb-6" style={{ background: 'var(--color-surface-deep)', border: '1px solid var(--color-border)' }}>
                <LogOut className="w-8 h-8 text-[var(--color-error)]" />
              </div>
              <h3 className="cred-heading-page mb-2 lowercase">leave arena?</h3>
              <p className="cred-subheading mb-8 lowercase">your current progression and streak will be preserved.</p>

              <div className="flex flex-col gap-3">
                <button
                  onClick={logout}
                  className="cred-cta-primary"
                  style={{ background: 'var(--color-error)' }}
                >
                  sign out
                </button>
                <button
                  onClick={() => setShowLogoutConfirm(false)}
                  className="cred-cta-secondary"
                >
                  cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Right / Sidebar: Live Activity Hub & CPA Stats */}
      <div className="lg:w-[360px] flex flex-col gap-6 shrink-0">

        {/* CPA / Transparency Stats */}
        <div className="cred-card relative overflow-hidden">
           <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-3xl pointer-events-none" />
           <div className="flex items-center gap-2 mb-1">
             <BarChart2 className="w-5 h-5 text-[var(--color-text-secondary)]" />
             <h4 className="cred-subheading lowercase font-semibold text-white">cpa daily metrics</h4>
           </div>
           <p className="cred-label mb-5 ml-7" style={{ color: 'var(--color-text-muted)' }}>RESETS AT 11:59 PM IST</p>

           <div className="grid grid-cols-2 gap-4 mb-4">
             <div className="cred-small-card flex flex-col items-center justify-center">
                <span className="cred-large-number text-2xl">{cpaStats.activeMatches.toLocaleString()}</span>
                <span className="cred-label mt-2">ACTIVE BATTLES</span>
             </div>
             <div className="cred-small-card flex flex-col items-center justify-center">
                <span className="cred-large-number text-2xl">{(cpaStats.totalXpGiven / 1000).toFixed(1)}k</span>
                <span className="cred-label mt-2">XP GIVEN</span>
             </div>
           </div>

           <div className="p-4 rounded-xl mb-4" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
              <span className="cred-label flex items-center gap-1 mb-2"><Star className="w-3 h-3 fill-[var(--color-gold)] text-[var(--color-gold)]"/> AI INSIGHT</span>
              <p className="cred-subheading text-white">"{insight}"</p>
           </div>

           <div className="cred-small-card flex items-center justify-between">
             <div className="flex items-center gap-2">
               <Users className="w-5 h-5 text-[var(--color-text-secondary)]" />
               <span className="cred-label">TOTAL ACCOUNTS</span>
             </div>
             <span className="cred-large-number text-xl">{cpaStats.newPlayersToday}</span>
           </div>
        </div>

         <div className="cred-card flex-1 flex flex-col min-h-[400px]">
            <div className="flex items-center justify-between mb-6">
               <div>
                  <h4 className="cred-subheading lowercase font-semibold text-white flex items-center gap-2">
                    <Activity className="w-4 h-4 text-[var(--color-error)]" /> live stadium
                  </h4>
                  <div className="flex items-center gap-1.5 mt-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-error)] animate-ping" />
                    <span className="cred-label">{scoutsCount.toLocaleString()} ONLINE</span>
                  </div>
               </div>
            </div>

               <div className="flex-1 space-y-4 overflow-y-auto scrollbar-none pr-2">
                  <AnimatePresence mode="popLayout">
                    {liveActivity.map((activity, idx) => (
                      <motion.div
                        key={idx + activity.text}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="flex gap-4 items-start group"
                      >
                        <div className="w-1.5 h-10 rounded-full flex-shrink-0 transition-colors" style={{ background: idx === 0 ? 'var(--color-text-primary)' : 'var(--color-border)' }} />
                        <div>
                          <p className="cred-subheading lowercase leading-tight mb-1 transition-colors" style={{ color: idx === 0 ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>{activity.text}</p>
                          <p className="cred-label" style={{ color: 'var(--color-text-muted)' }}>{activity.city} • {activity.time}</p>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
               </div>

            <div className="mt-6 p-4 rounded-xl" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
               <p className="cred-label mb-2 text-[var(--color-gold)]">COMMUNITY NOTE</p>
               <p className="cred-subheading lowercase text-white">matchmaking is currently peaking in mumbai and delhi.</p>
            </div>
         </div>
      </div>
    </motion.div>
  );
}
