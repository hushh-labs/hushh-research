import { motion } from 'motion/react';
import { User } from 'firebase/auth';
import { audio } from '../lib/audioManager';

interface SplashProps {
  onStart: () => void;
  user: User | null;
}

export default function Splash({ onStart, user }: SplashProps) {
  const handleStart = () => {
    audio.playTap();
    onStart();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="h-full flex flex-col items-center justify-between p-8"
      style={{ backgroundColor: 'var(--color-bg-screen)' }}
    >
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <motion.div
          initial={{ y: -50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="relative mb-12"
        >
          <div className="w-32 h-32 rounded-3xl flex flex-col items-center justify-center" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', boxShadow: '0 20px 60px rgba(0, 0, 0, 0.35)' }}>
            <span className="text-6xl drop-shadow-xl" style={{ filter: 'drop-shadow(0 0 20px rgba(183, 255, 60, 0.25))' }}>🏏</span>
          </div>
        </motion.div>

        <motion.h1
          className="cred-heading-hero lowercase mb-3"
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          hushh hand cricket
        </motion.h1>

        <motion.p
          className="cred-subheading max-w-sm mb-12"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
        >
          track your games, score high, and earn exclusive rewards in one premium view.
        </motion.p>
      </div>

      <div className="w-full max-w-md pb-6 flex flex-col gap-4 items-center">
        <motion.button
          onClick={handleStart}
          className="cred-cta-primary"
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.8 }}
        >
          {user ? "let's play" : "login with google"}
        </motion.button>

        <div className="cred-label">
          Winners announced daily at 11:59 PM IST
        </div>
      </div>
    </motion.div>
  );
}
