import { useState, useEffect } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, getDocFromServer } from 'firebase/firestore';
import { auth, db, signIn } from './firebase';
import { handleFirestoreError, OperationType } from './lib/firestoreErrorHandler';
import { UserProfile, Team } from './types';
import Splash from './components/Splash';
import TeamSelection from './components/TeamSelection';
import Dashboard from './components/Dashboard';
import Game from './components/Game';
import Matchmaking from './components/Matchmaking';
import MatchReplay from './components/MatchReplay';
import Leaderboard from './components/Leaderboard';
import { AnimatePresence, motion } from 'motion/react';
import { audio } from './lib/audioManager';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<'splash' | 'team-selection' | 'dashboard' | 'matchmaking' | 'game' | 'replay' | 'leaderboard'>('splash');
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  const [practiceDifficulty, setPracticeDifficulty] = useState<'easy' | 'medium' | 'hard'>('easy');
  const [replayMatchId, setReplayMatchId] = useState<string | null>(null);

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        console.log("Firebase connection successful");
      } catch (error: any) {
        if(error?.message?.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. The client is reporting offline.");
        } else {
          console.error("Firebase connection test error:", error);
        }
      }
    }
    testConnection();

    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const userRef = doc(db, 'users', u.uid);
        const userDoc = await getDoc(userRef);

        if (userDoc.exists()) {
          const data = userDoc.data() as UserProfile;
          // Check for 24h reset
          const lastReset = new Date(data.lastResetTime);
          const now = new Date();
          if (now.getTime() - lastReset.getTime() > 24 * 60 * 60 * 1000) {
            const updated = {
              ...data,
              gamesPlayed24h: 0,
              botGamesPlayed24h: 0,
              lastResetTime: now.toISOString(),
            };
            await setDoc(userRef, updated);
            setProfile(updated);
          } else {
            setProfile(data);
          }
          setScreen('dashboard');
        } else {
          setScreen('team-selection');
        }
      } else {
        setScreen('splash');
        setProfile(null);
      }
      setLoading(false);
    });
  }, []);

  const handleTeamSelect = async (team: Team) => {
    if (!user) return;
    const newProfile: UserProfile = {
      uid: user.uid,
      displayName: user.displayName || 'Player',
      team,
      gamesPlayed24h: 0,
      botGamesPlayed24h: 0,
      lastResetTime: new Date().toISOString(),
      lastClaimedReward: null,
      xp: 0,
      streak: 0,
      totalWins: 0,
      totalRuns: 0,
      totalGamesPlayed: 0,
      highestScore: 0,
    };
    try {
      await setDoc(doc(db, 'users', user.uid), newProfile);
      setProfile(newProfile);
      setScreen('dashboard');
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F0F7FF] text-slate-800 font-sans overflow-x-hidden relative">
      <div className="max-w-7xl mx-auto min-h-screen flex flex-col items-center">
        <main className="w-full max-w-lg lg:max-w-5xl xl:max-w-7xl flex-1 flex flex-col relative sm:px-4">
          <AnimatePresence mode="wait">
        {screen === 'splash' && (
          <motion.div key="splash" className="h-full">
            <Splash onStart={user ? () => setScreen('dashboard') : signIn} user={user} />
          </motion.div>
        )}
        {screen === 'team-selection' && (
          <motion.div key="team" className="h-full">
            <TeamSelection onSelect={handleTeamSelect} />
          </motion.div>
        )}
        {screen === 'dashboard' && profile && (
          <motion.div key="dashboard" className="h-full">
            <Dashboard
              profile={profile}
              onPlay={() => { audio.playTap(); setScreen('matchmaking'); }}
              onPractice={(difficulty) => {
                audio.playTap();
                setPracticeDifficulty(difficulty);
                setCurrentMatchId('practice');
                setScreen('game');
              }}
              onReplayMatch={(id) => {
                audio.playTap();
                setReplayMatchId(id);
                setScreen('replay');
              }}
              onOpenLeaderboard={() => {
                audio.playTap();
                setScreen('leaderboard');
              }}
            />
          </motion.div>
        )}
        {screen === 'matchmaking' && profile && (
          <motion.div key="matchmaking" className="h-full">
            <Matchmaking
              profile={profile}
              onMatchFound={(id) => {
                setCurrentMatchId(id);
                setScreen('game');
              }}
              onCancel={() => { audio.playTap(); setScreen('dashboard'); }}
            />
          </motion.div>
        )}
        {screen === 'game' && profile && currentMatchId && (
          <motion.div key="game" className="h-full">
            <Game
              matchId={currentMatchId}
              practiceDifficulty={practiceDifficulty}
              profile={profile}
              onClose={() => { audio.playTap(); setScreen('dashboard'); }}
              onUpdateProfile={(updated) => setProfile(updated)}
            />
          </motion.div>
        )}
        {screen === 'leaderboard' && profile && (
          <motion.div key="leaderboard" className="h-full">
            <Leaderboard
              currentUser={profile}
              onClose={() => { audio.playTap(); setScreen('dashboard'); }}
            />
          </motion.div>
        )}
        {screen === 'replay' && profile && replayMatchId && (
          <motion.div key="replay" className="h-full">
            <MatchReplay
              matchId={replayMatchId}
              profile={profile}
              onBack={() => { audio.playTap(); setScreen('dashboard'); setReplayMatchId(null); }}
            />
          </motion.div>
        )}
      </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
