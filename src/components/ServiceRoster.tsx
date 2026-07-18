"use client";

import { motion, AnimatePresence, type Variants, type Transition } from "framer-motion";
import { cn } from "@/utils/cn";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConnectedService {
  id: string;
  name: string;
  icon: string;
  status: "Active" | "Pending" | "Revoked";
  connectedAt: string;
  scopes: string[];
  lastSync: string;
}

interface ServiceRosterProps {
  services: ConnectedService[];
}

// ─── Status Config ───────────────────────────────────────────────────────────

const statusConfig = {
  Active: { bg: "bg-emerald-500/20", text: "text-emerald-400", badge: "bg-emerald-500/30 border-emerald-400/50" },
  Pending: { bg: "bg-amber-500/20", text: "text-amber-400", badge: "bg-amber-500/30 border-amber-400/50" },
  Revoked: { bg: "bg-rose-500/20", text: "text-rose-400", badge: "bg-rose-500/30 border-rose-400/50" },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function ServiceRoster({ services }: ServiceRosterProps) {
  const activeCount = services.filter((s) => s.status === "Active").length;

  const container: Variants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2,
      },
    },
  };

  const item: Variants = {
    hidden: { opacity: 0, y: 20 },
    show: {
      opacity: 1,
      y: 0,
      transition: {
        type: "spring",
        stiffness: 100,
        damping: 15,
      } as Transition,
    },
  };

  return (
    <motion.section
      className="space-y-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Connected Services</h2>
          <p className="text-sm text-slate-400 mt-1">
            {activeCount} active integration{activeCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Bento Grid */}
      <motion.div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
        variants={container}
        initial="hidden"
        animate="show"
      >
        <AnimatePresence>
          {services.map((service) => {
            const config = statusConfig[service.status];

            return (
              <motion.div
                key={service.id}
                variants={item}
                layout
                className="group relative"
              >
                <motion.div
                  className={cn(
                    "relative overflow-hidden rounded-xl border border-white/10 bg-white/5 backdrop-blur-xl p-6 h-full",
                    "transition-all duration-300 cursor-pointer"
                  )}
                  whileHover={{ scale: 1.02, y: -4 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                >
                  {/* Glowing border for Active services */}
                  {service.status === "Active" && (
                    <motion.div
                      className="absolute inset-0 rounded-xl pointer-events-none"
                      animate={{
                        boxShadow: [
                          "inset 0 0 20px rgba(16, 185, 129, 0.1)",
                          "inset 0 0 40px rgba(16, 185, 129, 0.2)",
                          "inset 0 0 20px rgba(16, 185, 129, 0.1)",
                        ],
                      }}
                      transition={{ duration: 3, repeat: Infinity }}
                    />
                  )}

                  {/* Animated gradient border */}
                  <motion.div
                    className="absolute -inset-0.5 rounded-xl opacity-0 group-hover:opacity-100 pointer-events-none"
                    style={{
                      background: `linear-gradient(45deg, transparent, ${
                        service.status === "Active"
                          ? "rgba(16, 185, 129, 0.3)"
                          : service.status === "Pending"
                          ? "rgba(251, 191, 36, 0.3)"
                          : "rgba(244, 63, 94, 0.3)"
                      }, transparent)`,
                    }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                  />

                  <div className="relative z-10 flex flex-col h-full min-h-48">
                    {/* Top Section: Icon & Status */}
                    <div className="flex items-start justify-between mb-4">
                      <motion.div
                        className="text-4xl"
                        whileHover={{ scale: 1.1, rotate: 5 }}
                        transition={{ type: "spring", stiffness: 400, damping: 10 }}
                      >
                        {service.icon}
                      </motion.div>

                      <motion.span
                        className={cn(
                          "text-xs font-semibold px-2.5 py-1 rounded-full border",
                          config.badge
                        )}
                        whileHover={{ scale: 1.05 }}
                      >
                        {service.status}
                      </motion.span>
                    </div>

                    {/* Service Name */}
                    <h3 className="text-lg font-bold text-white mb-1">{service.name}</h3>

                    {/* Scopes */}
                    <div className="mb-4 flex-1">
                      <p className="text-xs text-slate-400 mb-2 font-semibold uppercase opacity-70">
                        Scopes
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {service.scopes.slice(0, 3).map((scope, i) => (
                          <motion.span
                            key={i}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.1 * (i + 1) }}
                            className="text-xs bg-white/10 border border-white/20 text-slate-300 px-2 py-1 rounded"
                          >
                            {scope}
                          </motion.span>
                        ))}
                        {service.scopes.length > 3 && (
                          <span className="text-xs text-slate-500 px-2 py-1">
                            +{service.scopes.length - 3}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Footer: Last Sync */}
                    <motion.div
                      className="text-xs text-slate-500 border-t border-white/10 pt-3"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3 }}
                    >
                      <p className="flex items-center gap-2">
                        <motion.span
                          className="inline-block w-1.5 h-1.5 bg-emerald-400 rounded-full"
                          animate={{ scale: [1, 1.2, 1] }}
                          transition={{ duration: 2, repeat: Infinity }}
                        />
                        Last sync:{" "}
                        <span className="text-slate-400">
                          {new Date(service.lastSync).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </p>
                    </motion.div>
                  </div>
                </motion.div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </motion.div>
    </motion.section>
  );
}
