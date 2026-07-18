"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import useSWR from "swr";
import {
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/utils/cn";

// ─── Types ───────────────────────────────────────────────────────────────────

type AccessResult =
  | "Authorized"
  | "BLOCKED_BY_CONSENT"
  | "Denied"
  | "Rate_Limited";

interface AccessLogEntry {
  id: string;
  timestamp: string;
  service: string;
  action: string;
  resource: string;
  result: AccessResult;
  ip: string;
}

interface TrustDataResponse {
  user: { id: string; email: string; trustScore: number };
  connected_services: any[];
  permissions: any[];
  access_logs: AccessLogEntry[];
  metadata: { generatedAt: string; version: string };
}

interface AccessAuditLogProps {
  logs: AccessLogEntry[];
}

// ─── Result Config ────────────────────────────────────────────────────────

const RESULT_CONFIG: Record<
  AccessResult,
  { label: string; bg: string; border: string; icon: LucideIcon }
> = {
  Authorized: {
    label: "Authorized",
    bg: "bg-emerald-500/20 border-emerald-400/50",
    border: "border-emerald-400",
    icon: ShieldCheck,
  },
  BLOCKED_BY_CONSENT: {
    label: "Blocked",
    bg: "bg-rose-500/20 border-rose-400/50",
    border: "border-rose-400",
    icon: ShieldOff,
  },
  Denied: {
    label: "Denied",
    bg: "bg-rose-500/20 border-rose-400/50",
    border: "border-rose-400",
    icon: ShieldAlert,
  },
  Rate_Limited: {
    label: "Rate Limited",
    bg: "bg-amber-500/20 border-amber-400/50",
    border: "border-amber-400",
    icon: Clock,
  },
};

// ─── Fetcher ────────────────────────────────────────────────────────────────

async function fetcher(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch trust data");
  return res.json() as Promise<TrustDataResponse>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

// ─── Complex Live Pulse Indicator ────────────────────────────────────────────

function LivePulseIndicator({ isLive }: { isLive: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-3 h-3">
        {/* Core dot */}
        <motion.div
          className={cn(
            "absolute inset-0 rounded-full",
            isLive ? "bg-emerald-400" : "bg-slate-400"
          )}
          animate={isLive ? { scale: [1, 1.1, 1] } : {}}
          transition={{ duration: 2, repeat: Infinity }}
        />
        
        {/* First ring */}
        {isLive && (
          <motion.div
            className="absolute inset-0 rounded-full border border-emerald-400"
            animate={{ scale: [1, 1.8, 2.2], opacity: [1, 0.5, 0] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        )}
        
        {/* Second ring */}
        {isLive && (
          <motion.div
            className="absolute inset-0 rounded-full border border-emerald-400"
            animate={{ scale: [1, 1.6, 2], opacity: [0.8, 0.3, 0] }}
            transition={{ duration: 2.5, repeat: Infinity, delay: 0.3 }}
          />
        )}
      </div>
      <span className={cn(
        "text-xs font-semibold",
        isLive ? "text-emerald-400" : "text-slate-400"
      )}>
        {isLive ? "Live" : "Ready"}
      </span>
    </div>
  );
}

// ─── Result Badge ────────────────────────────────────────────────────────────

function ResultBadge({ result }: { result: AccessResult }) {
  const config = RESULT_CONFIG[result];
  const Icon = config.icon;
  
  return (
    <motion.span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap border",
        config.bg,
        config.border,
        "transition-all"
      )}
      whileHover={{ scale: 1.05 }}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </motion.span>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AccessAuditLog({ logs: initialLogs }: AccessAuditLogProps) {
  const [newLogIds, setNewLogIds] = useState<Set<string>>(new Set());
  const [highlightedLogId, setHighlightedLogId] = useState<string | null>(null);

  const { data } = useSWR<TrustDataResponse>(
    "/api/trust-data",
    fetcher,
    {
      refreshInterval: 5000,
      dedupingInterval: 2000,
      revalidateOnFocus: false,
    }
  );

  const logs = data?.access_logs ?? initialLogs;

  useEffect(() => {
    if (!data) return;

    const currentLogIds = new Set(logs.map((log) => log.id));
    const initialLogIds = new Set(initialLogs.map((log) => log.id));
    const newIds = Array.from(currentLogIds).filter((id) => !initialLogIds.has(id));

    if (newIds.length > 0) {
      setNewLogIds((prev) => new Set([...prev, ...newIds]));

      const securityAlerts = logs.filter(
        (log) =>
          newIds.includes(log.id) &&
          (log.result === "BLOCKED_BY_CONSENT" || log.result === "Denied")
      );

      if (securityAlerts.length > 0) {
        const firstAlertId = securityAlerts[0].id;
        setHighlightedLogId(firstAlertId);

        const timer = setTimeout(() => {
          setHighlightedLogId(null);
        }, 2000);

        return () => clearTimeout(timer);
      }
    }
  }, [data, logs, initialLogs]);

  const isLive = !!data;

  return (
    <motion.section
      className="space-y-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.5 }}
    >
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-white">Access Audit Log</h2>
          <LivePulseIndicator isLive={isLive} />
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {logs.length} access attempts
        </p>
      </div>

      <motion.div 
        className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-lg overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6 }}
      >
        {/* ─── Desktop Table ───────────────────────────────────────────── */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Timestamp
                </th>
                <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Service
                </th>
                <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Action
                </th>
                <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Resource
                </th>
                <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Result
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              <AnimatePresence>
                {logs.map((log, idx) => {
                  const isNew = newLogIds.has(log.id);
                  const isHighlighted = highlightedLogId === log.id;

                  return (
                    <motion.tr
                      key={log.id}
                      layout
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ type: "spring", stiffness: 100, damping: 15, delay: idx * 0.02 }}
                      className={cn(
                        "transition-all duration-300 hover:bg-white/10 cursor-pointer",
                        isHighlighted && "bg-rose-500/20 border-l-2 border-rose-400",
                        isNew && !isHighlighted && "bg-emerald-500/10 border-l-2 border-emerald-400"
                      )}
                      whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.1)" }}
                    >
                      <td className="whitespace-nowrap px-6 py-4 text-slate-400 text-xs font-mono">
                        {formatTimestamp(log.timestamp)}
                      </td>
                      <td className="px-6 py-4 font-medium text-white">
                        {log.service}
                      </td>
                      <td className="px-6 py-4">
                        <motion.span 
                          className="inline-flex rounded-md bg-white/10 border border-white/20 px-2 py-1 text-xs font-mono text-slate-300"
                          whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.15)" }}
                        >
                          {log.action}
                        </motion.span>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-400">
                        {log.resource}
                      </td>
                      <td className="px-6 py-4">
                        <ResultBadge result={log.result} />
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>

        {/* ─── Mobile Cards ────────────────────────────────────────────── */}
        <motion.div 
          className="md:hidden divide-y divide-white/10"
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
          <AnimatePresence>
            {logs.map((log) => {
              const isNew = newLogIds.has(log.id);
              const isHighlighted = highlightedLogId === log.id;

              return (
                <motion.div
                  key={log.id}
                  layout
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  transition={{ type: "spring", stiffness: 100, damping: 15 }}
                  className={cn(
                    "px-6 py-4 space-y-2.5 transition-all duration-300",
                    isHighlighted && "bg-rose-500/20 border-l-2 border-rose-400",
                    isNew && !isHighlighted && "bg-emerald-500/10 border-l-2 border-emerald-400"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <motion.span 
                      className="font-medium text-sm text-white"
                      whileHover={{ x: 2 }}
                    >
                      {log.service}
                    </motion.span>
                    <ResultBadge result={log.result} />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="inline-flex rounded-md bg-white/10 px-2 py-1 font-mono text-slate-300 border border-white/20">
                      {log.action}
                    </span>
                    <span className="font-mono truncate">{log.resource}</span>
                  </div>
                  <p className="text-xs font-mono text-slate-500">
                    {formatTimestamp(log.timestamp)}
                  </p>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </motion.section>
  );
}
