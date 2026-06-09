"use client";

export {
  ChartSurfaceCard,
  FallbackSurfaceCard,
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceDataTableShell,
  SurfaceInset,
  SurfaceStack,
  surfaceDataTableShellClassName,
  surfaceInsetClassName,
  surfaceInteractiveShellClassName,
  type SurfaceAccent,
  type SurfaceTone,
} from "@/lib/morphy-ux/surfaces";

// ---------------------------------------------------------------------------
// SkillValidationCard — AI-Powered Smart Resume Validator card
// Used by: app/kai/page.tsx (Skill Pipeline)
// ---------------------------------------------------------------------------
import { motion } from "framer-motion";

interface SkillValidationCardProps {
  name: string;
  status: "processing" | "verified";
}

export const SkillValidationCard = ({ name, status }: SkillValidationCardProps) => {
  const isVerified = status === "verified";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-between p-4 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl mb-4 shadow-lg"
    >
      <div className="flex flex-col gap-1">
        <span className="font-semibold text-white tracking-wide">{name}</span>
        <span className="text-[10px] text-white/40 uppercase font-bold tracking-widest">
          {isVerified ? "Hushh Protocol Verified" : "Awaiting AI Evidence"}
        </span>
      </div>

      <div
        className={`px-4 py-1.5 rounded-full text-[11px] font-black uppercase tracking-tighter transition-all duration-500 ${
          isVerified
            ? "bg-green-500/20 text-green-400 border border-green-500/40"
            : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 animate-pulse"
        }`}
      >
        {isVerified ? "✓ Verified" : "AI Verifying..."}
      </div>
    </motion.div>
  );
};
