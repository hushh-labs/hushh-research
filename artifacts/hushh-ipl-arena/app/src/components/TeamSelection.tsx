import { motion } from 'motion/react';
import { Team } from '../types';
import { cn } from '../lib/utils';
import { useState } from 'react';
import { Building2, Palmtree, Landmark, Train, Waves, Castle } from 'lucide-react';
import { audio } from '../lib/audioManager';

const TEAMS: { name: Team; color: string; icon: any }[] = [
  { name: 'Bengaluru', color: 'bg-[#FF3B30]', icon: Building2 }, // Vibrant Red
  { name: 'Chennai', color: 'bg-[#FFCC00]', icon: Palmtree }, // Vibrant Yellow
  { name: 'Delhi', color: 'bg-[#007AFF]', icon: Landmark }, // Vibrant Blue
  { name: 'Kolkata', color: 'bg-[#AF52DE]', icon: Train }, // Vibrant Purple
  { name: 'Mumbai', color: 'bg-[#34C759]', icon: Waves }, // Vibrant Green
  { name: 'Hyderabad', color: 'bg-[#FF9500]', icon: Castle }, // Vibrant Orange
];

interface TeamSelectionProps {
  onSelect: (team: Team) => void;
}

export default function TeamSelection({ onSelect }: TeamSelectionProps) {
  const [selected, setSelected] = useState<Team | null>(null);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="w-full flex-1 flex flex-col p-6 bg-[#F2F2F7]"
    >
      <div className="text-center mb-8 pt-12">
        <h2 className="text-3xl font-extrabold tracking-tighter text-black uppercase mb-2">PICK YOUR TEAM</h2>
        <p className="text-black/50 text-[10px] font-black uppercase tracking-widest opacity-60">5 Bonus matches on your team's game day</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-6 flex-1 overflow-y-auto scrollbar-none px-2 pb-8">
        {TEAMS.map((team) => (
          <motion.div
            key={team.name}
            animate={
              selected === team.name
                ? { scale: 1.05, boxShadow: "0 0 24px rgba(20, 184, 166, 0.4)", y: -8 }
                : { scale: 1, boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)", y: 0 }
            }
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            whileHover={selected === team.name ? {} : { scale: 1.02, y: -4, boxShadow: "0 10px 20px rgba(0,0,0,0.08)" }}
            whileTap={{ scale: 0.95 }}
            onClick={() => {
              audio.playTap();
              setSelected(team.name);
            }}
            className={cn(
              "relative aspect-square rounded-[32px] p-4 flex flex-col items-center justify-center cursor-pointer border",
              selected === team.name
                ? "border-[#007AFF] bg-white shadow-[0_0_0_2px_#007AFF,0_8px_30px_rgb(0,0,0,0.12)]"
                : "border-[#E5E5EA] bg-white hover:bg-white/90 shadow-sm"
            )}
          >
            <div className={cn(
              "w-16 h-16 rounded-2xl flex items-center justify-center mb-4 shadow-sm",
              selected === team.name ? "text-white" + " " + team.color : "bg-black/5 text-black/40"
            )}>
              <team.icon size={32} strokeWidth={2.5} />
            </div>
            <span className={cn(
              "font-black text-sm uppercase tracking-tighter",
              selected === team.name ? "text-black" : "text-black/60"
            )}>{team.name}</span>
            <div className={cn("absolute bottom-4 h-1.5 w-8 rounded-full", team.color)} />
          </motion.div>
        ))}
      </div>

      <motion.button
        disabled={!selected}
        whileHover={selected ? { scale: 1.02 } : {}}
        whileTap={selected ? { scale: 0.98 } : {}}
        onClick={() => {
          if (selected) {
            audio.playTap();
            onSelect(selected);
          }
        }}
        className={cn(
          "max-w-md mx-auto w-full py-5 mt-auto rounded-full font-bold text-xl uppercase transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95",
          selected
            ? "bg-[#1C1C1E] text-white"
            : "bg-[#E5E5EA] text-[#8E8E93] shadow-none cursor-not-allowed"
        )}
      >
        Confirm Scout
      </motion.button>

      <p className="text-center text-[10px] font-bold text-black/40 mt-4 uppercase tracking-[0.2em] opacity-40">
        Team selection is permanent
      </p>
    </motion.div>
  );
}
