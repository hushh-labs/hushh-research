"use client";

import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Share2,
  Bell,
  ShieldCheck,
  Eye,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/utils/cn";

// ─── Types ───────────────────────────────────────────────────────────────────

type PermissionState = "On" | "Off";

interface Permission {
  id: string;
  category: string;
  label: string;
  description: string;
  state: PermissionState;
  lastModified: string;
}

interface PermissionManagerProps {
  permissions: Permission[];
}

// ─── Category Config ─────────────────────────────────────────────────────────

const CATEGORY_ICON: Record<string, LucideIcon> = {
  "Data Sharing": Share2,
  Notifications: Bell,
  Security: ShieldCheck,
  Privacy: Eye,
};

const CATEGORY_COLOR: Record<string, { icon: string; bg: string; text: string }> = {
  "Data Sharing": { icon: "text-indigo-400", bg: "bg-indigo-500/20", text: "text-indigo-300" },
  Notifications: { icon: "text-violet-400", bg: "bg-violet-500/20", text: "text-violet-300" },
  Security: { icon: "text-emerald-400", bg: "bg-emerald-500/20", text: "text-emerald-300" },
  Privacy: { icon: "text-amber-400", bg: "bg-amber-500/20", text: "text-amber-300" },
};

// ─── Liquid Toggle Switch ────────────────────────────────────────────────────

function LiquidToggle({
  checked,
  onChange,
  isLoading,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  isLoading?: boolean;
  ariaLabel: string;
}) {
  return (
    <motion.button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={isLoading}
      className={cn(
        "relative inline-flex h-7 w-14 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-slate-900",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-emerald-500/30 border-emerald-400/50" : "bg-rose-500/30 border-rose-400/50"
      )}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
    >
      <motion.span
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full shadow-lg ring-0",
          checked ? "bg-gradient-to-br from-emerald-300 to-emerald-500" : "bg-gradient-to-br from-rose-300 to-rose-500"
        )}
        layout
        transition={{
          type: "spring",
          stiffness: 700,
          damping: 30,
        }}
        style={{
          x: checked ? 28 : 2,
        }}
      />
      
      {/* Animated background pulse */}
      <motion.div
        className={cn(
          "absolute inset-0 rounded-full",
          checked ? "bg-emerald-500/10" : "bg-rose-500/10"
        )}
        animate={{
          scale: isLoading ? [1, 1.2, 1] : 1,
          opacity: isLoading ? [0.5, 1, 0.5] : 0,
        }}
        transition={{ duration: 1.5, repeat: Infinity }}
      />
    </motion.button>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PermissionManager({
  permissions,
}: PermissionManagerProps) {
  const [states, setStates] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    permissions.forEach((p) => {
      initial[p.id] = p.state === "On";
    });
    return initial;
  });

  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  const handleToggle = useCallback(
    async (permission: Permission) => {
      const currentValue = states[permission.id];
      const newValue = !currentValue;
      const newState = newValue ? "On" : "Off";

      // Optimistic update
      setStates((prev) => ({ ...prev, [permission.id]: newValue }));
      setLoadingIds((prev) => new Set(prev).add(permission.id));

      try {
        const response = await fetch("/api/permissions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            permissionId: permission.id,
            newState: newState,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to update permission");
        }

        console.log(
          `✓ Permission "${permission.label}" successfully updated to ${newState}`
        );
      } catch (error) {
        // Revert on error
        setStates((prev) => ({ ...prev, [permission.id]: currentValue }));
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `✗ Failed to update permission "${permission.label}": ${errorMessage}`
        );
      } finally {
        setLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(permission.id);
          return next;
        });
      }
    },
    [states]
  );

  // Group permissions by category
  const grouped = permissions.reduce<Record<string, Permission[]>>(
    (acc, perm) => {
      if (!acc[perm.category]) acc[perm.category] = [];
      acc[perm.category].push(perm);
      return acc;
    },
    {}
  );

  const categoryOrder = ["Data Sharing", "Notifications", "Security", "Privacy"];

  return (
    <motion.section
      className="space-y-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
    >
      <div>
        <h2 className="text-2xl font-bold text-white">Permissions</h2>
        <p className="mt-1 text-sm text-slate-400">
          Control what data services can access
        </p>
      </div>

      <div className="space-y-5">
        {categoryOrder.map((category, catIdx) => {
          const perms = grouped[category] || [];
          if (!perms.length) return null;

          const Icon = CATEGORY_ICON[category] ?? Eye;
          const colors = CATEGORY_COLOR[category] || { icon: "text-slate-400", bg: "bg-slate-500/20", text: "text-slate-300" };

          return (
            <motion.div
              key={category}
              className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-lg overflow-hidden"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + catIdx * 0.1 }}
            >
              {/* Category header */}
              <motion.div 
                className={cn(
                  "flex items-center gap-3 border-b border-white/10 px-6 py-4",
                  colors.bg
                )}
                whileHover={{ backgroundColor: "rgba(255,255,255,0.08)" }}
              >
                <motion.div
                  whileHover={{ rotate: 10, scale: 1.1 }}
                  transition={{ type: "spring", stiffness: 400 }}
                >
                  <Icon className={cn("h-5 w-5", colors.icon)} />
                </motion.div>
                <h3 className={cn("text-sm font-semibold", colors.text)}>
                  {category}
                </h3>
              </motion.div>

              {/* Permission rows */}
              <motion.div 
                className="divide-y divide-white/10"
                variants={{
                  hidden: { opacity: 0 },
                  show: {
                    opacity: 1,
                    transition: {
                      staggerChildren: 0.05,
                    },
                  },
                }}
                initial="hidden"
                animate="show"
              >
                {perms.map((perm) => (
                  <motion.div
                    key={perm.id}
                    className="flex items-center justify-between gap-4 px-6 py-4 transition-all hover:bg-white/5"
                    variants={{
                      hidden: { opacity: 0, x: -20 },
                      show: { opacity: 1, x: 0 },
                    }}
                    transition={{ type: "spring", stiffness: 100, damping: 15 }}
                  >
                    <div className="min-w-0">
                      <motion.p 
                        className="text-sm font-medium text-white"
                        whileHover={{ x: 2 }}
                      >
                        {perm.label}
                      </motion.p>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                        {perm.description}
                      </p>
                    </div>
                    <motion.div whileHover={{ scale: 1.05 }}>
                      <LiquidToggle
                        checked={states[perm.id]}
                        onChange={() => handleToggle(perm)}
                        isLoading={loadingIds.has(perm.id)}
                        ariaLabel={`Toggle permission: ${category} - ${perm.label}`}
                      />
                    </motion.div>
                  </motion.div>
                ))}
              </motion.div>
            </motion.div>
          );
        })}
      </div>
    </motion.section>
  );
}
