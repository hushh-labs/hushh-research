"use client";

import { useState, useEffect } from "react";
import { Shield } from "lucide-react";
import { motion } from "framer-motion";
import ServiceRoster from "@/components/ServiceRoster";
import PermissionManager from "@/components/PermissionManager";
import AccessAuditLog from "@/components/AccessAuditLog";
import SignOutButton from "@/components/SignOutButton";

// ─── Types (mirroring the API response) ──────────────────────────────────────

interface ConnectedService {
  id: string;
  name: string;
  icon: string;
  status: "Active" | "Pending" | "Revoked";
  connectedAt: string;
  scopes: string[];
  lastSync: string;
}

interface Permission {
  id: string;
  category: string;
  label: string;
  description: string;
  state: "On" | "Off";
  lastModified: string;
}

interface AccessLog {
  id: string;
  timestamp: string;
  service: string;
  action: string;
  resource: string;
  result: "Authorized" | "BLOCKED_BY_CONSENT" | "Denied" | "Rate_Limited";
  ip: string;
}

interface TrustDataResponse {
  user: { id: string; email: string; trustScore: number };
  connected_services: ConnectedService[];
  permissions: Permission[];
  access_logs: AccessLog[];
  metadata: { generatedAt: string; version: string };
}

// ─── Data Fetching ───────────────────────────────────────────────────────────

async function getTrustData(): Promise<TrustDataResponse> {
  const res = await fetch('/api/trust-data', {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch trust data: ${res.statusText}`);
  }

  return res.json();
}

// ─── Trust Score Ring Component ──────────────────────────────────────────────

function TrustScoreRing({ score }: { score: number }) {
  const isHealthy = score > 80;
  const borderClass = isHealthy ? "border-emerald-500" : "border-amber-500";
  const textClass = isHealthy ? "text-emerald-700" : "text-amber-700";
  const bgClass = isHealthy ? "bg-emerald-50" : "bg-amber-50";

  return (
    <motion.div 
      className="flex flex-col items-center justify-center gap-4"
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 100, damping: 15, delay: 0.2 }}
    >
      <motion.div
        className={`relative h-32 w-32 rounded-full border-4 ${borderClass} ${bgClass} flex items-center justify-center`}
        whileHover={{ scale: 1.05 }}
        transition={{ type: "spring", stiffness: 300, damping: 10 }}
      >
        {/* Glowing ring effect */}
        <motion.div
          className={`absolute inset-0 rounded-full border-2 ${borderClass} opacity-0`}
          animate={{
            boxShadow: isHealthy
              ? ["0 0 20px rgba(16, 185, 129, 0.5)", "0 0 40px rgba(16, 185, 129, 0.2)"]
              : ["0 0 20px rgba(251, 191, 36, 0.5)", "0 0 40px rgba(251, 191, 36, 0.2)"],
          }}
          transition={{ duration: 3, repeat: Infinity }}
        />
        <div className="text-center relative z-10">
          <motion.div 
            className={`text-5xl font-bold ${textClass}`}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 200, delay: 0.4 }}
          >
            {score}
          </motion.div>
          <div className={`text-xs uppercase tracking-widest ${textClass} opacity-75`}>
            %
          </div>
        </div>
      </motion.div>
      <motion.div 
        className="text-center"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
      >
        <p className="text-sm font-medium text-slate-500">Trust Score</p>
        <p className={`text-xs ${textClass}`}>
          {isHealthy ? "Excellent privacy posture" : "Review recommended actions"}
        </p>
      </motion.div>
    </motion.div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data, setData] = useState<TrustDataResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const res = await fetch('/api/trust-data', {
          cache: "no-store",
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch trust data: ${res.statusText}`);
        }

        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <motion.div 
          className="text-center space-y-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <motion.div 
            className="inline-block"
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          >
            <div className="h-12 w-12 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full" />
          </motion.div>
          <p className="text-slate-400">Loading your privacy dashboard...</p>
        </motion.div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <motion.div 
          className="text-center space-y-4 max-w-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <h2 className="text-xl font-bold text-white">Unable to Load Dashboard</h2>
          <p className="text-slate-400">{error || 'No data available'}</p>
          <motion.button 
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            Try Again
          </motion.button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 relative overflow-hidden">
      {/* Animated background elements */}
      <motion.div
        className="fixed inset-0 pointer-events-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1 }}
      >
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl" />
        <motion.div
          className="absolute top-0 right-0 w-80 h-80 bg-purple-500/5 rounded-full blur-3xl"
          animate={{ y: [0, 20, 0] }}
          transition={{ duration: 8, repeat: Infinity }}
        />
      </motion.div>

      {/* ─── Header ─────────────────────────────────────────────────── */}
      <motion.header 
        className="border-b border-white/10 bg-slate-900/50 backdrop-blur-xl sticky top-0 z-50"
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ type: "spring", stiffness: 100, damping: 20 }}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <motion.div 
              className="flex items-center gap-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
            >
              <motion.div 
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 border border-emerald-300/50 shadow-lg shadow-emerald-500/30"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                <Shield className="h-5 w-5 text-white" />
              </motion.div>
              <div>
                <h1 className="text-base font-bold text-white tracking-tight">
                  Hussh
                </h1>
                <p className="text-[10px] uppercase tracking-widest text-slate-400">
                  Privacy Trust Dashboard
                </p>
              </div>
            </motion.div>

            {/* Right Side: Trust Score Pill + User Profile + Sign Out */}
            <motion.div 
              className="flex items-center gap-4"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
            >
              {/* Compact Trust Score Pill (Quick Reference) */}
              <motion.div 
                className="hidden sm:flex items-center gap-2 rounded-full border border-white/10 bg-white/5 backdrop-blur-lg px-4 py-1.5 hover:bg-white/10 transition-colors"
                whileHover={{ scale: 1.05 }}
              >
                <span className="text-xs text-slate-300">Trust Score</span>
                <span
                  className={`text-sm font-bold ${
                    data.user.trustScore > 80
                      ? "text-emerald-400"
                      : "text-amber-400"
                  }`}
                >
                  {data.user.trustScore}%
                </span>
              </motion.div>

              {/* User Profile + Sign Out */}
              <div className="flex items-center gap-3">
                <SignOutButton />
              </div>
            </motion.div>
          </div>
        </div>
      </motion.header>

      {/* ─── Main ───────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 space-y-12 lg:py-12 relative z-10">
        {/* Hero: Trust Score Section */}
        <motion.section 
          className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-8 sm:p-12 lg:p-14 shadow-2xl"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 100, damping: 20 }}
        >
          <div className="flex flex-col items-center justify-center">
            <TrustScoreRing score={data.user.trustScore} />
            <motion.div 
              className="mt-6 text-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8 }}
            >
              <p className="text-sm text-slate-400">Account Email</p>
              <p className="mt-1 text-base font-medium text-white">
                {data.user.email}
              </p>
            </motion.div>
          </div>
        </motion.section>

        {/* Services */}
        <ServiceRoster services={data.connected_services} />

        {/* Permissions + Audit in two-column on large screens */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
          <PermissionManager permissions={data.permissions} />
          <AccessAuditLog logs={data.access_logs} />
        </div>
      </main>

      {/* ─── Footer ─────────────────────────────────────────────────── */}
      <motion.footer 
        className="border-t border-white/10 py-6 text-center text-xs text-slate-400"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1 }}
      >
        Hussh{" "}
        <span className="font-mono text-slate-500">v{data.metadata.version}</span>{" "}
        - Data as of{" "}
        <span className="font-mono text-slate-500">
          {new Date(data.metadata.generatedAt).toLocaleString()}
        </span>
      </motion.footer>
    </div>
  );
}
