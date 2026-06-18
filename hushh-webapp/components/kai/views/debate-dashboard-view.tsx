"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, ShieldAlert, Zap, LoaderCircle, RefreshCw, CircleAlert, Bot, ShieldCheck } from "lucide-react";
import { DebateVerdictCard } from "@/components/kai/cards/renaissance-verdict-card";
import { useVault } from "@/lib/vault/vault-context";
import { useAuth } from "@/lib/firebase/auth-context";
import { ConsentDialog } from "@/components/consent/consent-dialog";
import type { ConsentRequest } from "@/components/consent/consent-dialog";
import { cn } from "@/lib/utils";

export type DebateVerdict = {
  final_score: number;
  label: string;
};

export function DebateDashboardView({ ticker = "AAPL" }: { ticker?: string }) {
  const { vaultOwnerToken } = useVault();
  const { user } = useAuth();
  
  const [bullPoints, setBullPoints] = useState<string[]>([]);
  const [bearPoints, setBearPoints] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<DebateVerdict | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "streaming" | "error" | "finished" | "consent_required">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  const [showConsent, setShowConsent] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const verdictReceivedRef = useRef(false);

  const consentRequest: ConsentRequest = {
    agentId: "agent_kai",
    agentName: "KAI Investment Jury",
    scope: "agent.kai.debate",
    scopeDescription: "Analyze your financial profile to provide personalized investment arguments.",
    scopeLabel: "Investment Analysis Consent",
    dataFields: ["Risk Profile", "Available Balance", "Portfolio Holdings"],
    expiresInDays: 7
  };

  const startDebate = useCallback((hasConsent = false) => {
    if (!hasConsent) {
      setStatus("consent_required");
      setShowConsent(true);
      return;
    }

    // Reset state
    setBullPoints([]);
    setBearPoints([]);
    setVerdict(null);
    verdictReceivedRef.current = false;
    setStatus("connecting");
    setErrorMsg(null);
    setShowConsent(false);

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      // Use URLSearchParams for safe query construction
      const params = new URLSearchParams();
      params.append("ticker", ticker);
      if (user?.uid) params.append("user_id", user.uid);
      if (vaultOwnerToken) params.append("consent_token", vaultOwnerToken);
      
      const eventSource = new EventSource(`/api/kai/debate/stream?${params.toString()}`);
      eventSourceRef.current = eventSource;

      eventSource.addEventListener("open", () => {
        setStatus("streaming");
      });

      eventSource.addEventListener("bull_point", (e: any) => {
        setStatus("streaming");
        const data = JSON.parse(e.data) as { point: string };
        setBullPoints((prev) => [...prev, data.point]);
      });

      eventSource.addEventListener("bear_point", (e: any) => {
        const data = JSON.parse(e.data) as { point: string };
        setBearPoints((prev) => [...prev, data.point]);
      });

      eventSource.addEventListener("verdict", (e: any) => {
        const data = JSON.parse(e.data) as DebateVerdict;
        setVerdict(data);
        verdictReceivedRef.current = true;
        setStatus("finished");
        eventSource.close();
      });

      eventSource.addEventListener("error", () => {
        if (!verdictReceivedRef.current) {
          setStatus("error");
          setErrorMsg("Connection to the AI Jury was lost. The server might be offline or busy.");
        } else {
          setStatus("finished");
        }
        eventSource.close();
      });
    } catch (_err) {
      setStatus("error");
      setErrorMsg("Failed to initialize the debate stream.");
    }
  }, [ticker, user, vaultOwnerToken]);

  // Handle initial connection
  useEffect(() => {
    if (status === "idle") {
      startDebate();
    }
  }, [status, startDebate]);

  // Clean up on unmount ONLY
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  const resetDebate = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setBullPoints([]);
    setBearPoints([]);
    setVerdict(null);
    verdictReceivedRef.current = false;
    setStatus("idle"); // Setting back to idle will trigger the startDebate effect
    setErrorMsg(null);
    setShowConsent(false);
  };

  const isLoading = status === "connecting" && bullPoints.length === 0 && bearPoints.length === 0;

  return (
    <SurfaceInset className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-border pb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">AI Investment Jury</h1>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-muted-foreground text-sm">
                {isLoading ? `Preparing debate for ${ticker}...` : `Live debate analysis for ${ticker}`}
              </p>
              {(status === "streaming" || status === "connecting") && (
                <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={resetDebate}
              className="rounded-full px-5 h-10 gap-2 border-border/60 hover:bg-muted"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", status === "connecting" && "animate-spin")} />
              Retry Debate
            </Button>
            <Badge variant="outline" className="text-lg py-1.5 px-4 font-mono shadow-sm">
              {ticker}
            </Badge>
          </div>
        </header>

        {isLoading ? (
          <div className="grid md:grid-cols-2 gap-6 animate-pulse">
            <Skeleton className="h-[400px] w-full rounded-2xl bg-muted/40" />
            <Skeleton className="h-[400px] w-full rounded-2xl bg-muted/40" />
          </div>
        ) : (
          <>
            {status === "consent_required" && (
              <div className="bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 p-8 rounded-3xl flex flex-col items-center justify-center space-y-6 text-center shadow-sm">
                <div className="h-16 w-16 bg-blue-500/20 rounded-full flex items-center justify-center">
                  <ShieldCheck className="h-8 w-8 text-blue-500" />
                </div>
                <div className="max-w-md">
                  <h3 className="font-bold text-xl">Consent Required</h3>
                  <p className="text-sm opacity-90 mt-2 leading-relaxed">
                    To provide personalized arguments based on your risk profile and balance, 
                    KAI needs your permission to read your financial metadata from your secure vault.
                  </p>
                </div>
                <Button 
                  id="debate-grant-consent-button"
                  onClick={() => setShowConsent(true)} 
                  className="px-8 bg-blue-600 hover:bg-blue-700 text-white rounded-full transition-all hover:scale-105 active:scale-95 shadow-md"
                >
                  Grant Access & Start Debate
                </Button>
              </div>
            )}

            {status === "error" && bullPoints.length === 0 && bearPoints.length === 0 && (
              <div className="bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 p-6 rounded-2xl flex flex-col items-center justify-center space-y-4">
                <CircleAlert className="h-10 w-10 opacity-80" />
                <div className="text-center">
                  <h3 className="font-semibold text-lg">Unable to connect to AI Jury</h3>
                  <p className="text-sm opacity-80 mt-1">{errorMsg}</p>
                </div>
                <Button id="debate-retry-button-error-state" variant="outline" onClick={resetDebate} className="mt-2 border-rose-500/30 text-rose-600 hover:bg-rose-500/10">
                  Try Again
                </Button>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-6">
              {/* Bull Column */}
              <div className="space-y-4">
                <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-400 border-b border-emerald-500/20 pb-2">
                  <div className="bg-emerald-500/10 p-2 rounded-lg flex items-center justify-center">
                    <TrendingUp className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      The Bull
                    </h2>
                    <p className="text-xs font-medium text-emerald-600/70 flex items-center gap-1">
                      <Bot className="h-3 w-3" /> Alpha Agent
                    </p>
                  </div>
                  {status === "streaming" && bearPoints.length === 0 && (
                    <span className="flex h-3 w-3 ml-auto relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                    </span>
                  )}
                </div>
                <SurfaceInset className="border-emerald-500/20 bg-emerald-500/5 p-6 space-y-5 rounded-2xl shadow-sm min-h-[200px]">
                  {bullPoints.length === 0 && status !== "error" && (
                    <div className="h-full flex items-center justify-center text-emerald-600/50 italic text-sm py-10">
                      Preparing opening statement...
                    </div>
                  )}
                  {bullPoints.map((point, i) => (
                    <div key={i} className="flex gap-4 text-sm leading-relaxed text-emerald-950 dark:text-emerald-50 animate-in fade-in slide-in-from-bottom-2 duration-500">
                      <div className="mt-0.5 bg-emerald-100 dark:bg-emerald-900/50 p-1.5 rounded-full shrink-0 h-fit border border-emerald-500/20">
                        <Zap className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <p className="pt-0.5">{point}</p>
                    </div>
                  ))}
                </SurfaceInset>
              </div>

              {/* Bear Column */}
              <div className="space-y-4">
                <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400 border-b border-rose-500/20 pb-2">
                  <div className="bg-rose-500/10 p-2 rounded-lg flex items-center justify-center">
                    <TrendingDown className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold uppercase tracking-wider text-rose-700 dark:text-rose-300">
                      The Bear
                    </h2>
                    <p className="text-xs font-medium text-rose-600/70 flex items-center gap-1">
                      <Bot className="h-3 w-3" /> Omega Agent
                    </p>
                  </div>
                  {status === "streaming" && bullPoints.length > 0 && !verdict && (
                    <span className="flex h-3 w-3 ml-auto relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500"></span>
                    </span>
                  )}
                </div>
                <SurfaceInset className="border-rose-500/20 bg-rose-500/5 p-6 space-y-5 rounded-2xl shadow-sm min-h-[200px]">
                  {bearPoints.length === 0 && status !== "error" && (
                    <div className="h-full flex items-center justify-center text-rose-600/50 italic text-sm py-10">
                      Waiting for rebuttal...
                    </div>
                  )}
                  {bearPoints.map((point, i) => (
                    <div key={i} className="flex gap-4 text-sm leading-relaxed text-rose-950 dark:text-rose-50 animate-in fade-in slide-in-from-bottom-2 duration-500">
                      <div className="mt-0.5 bg-rose-100 dark:bg-rose-900/50 p-1.5 rounded-full shrink-0 h-fit border border-rose-500/20">
                        <ShieldAlert className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
                      </div>
                      <p className="pt-0.5">{point}</p>
                    </div>
                  ))}
                </SurfaceInset>
              </div>
            </div>

            <div className="pt-4 min-h-[200px]">
              {verdict ? (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
                  <DebateVerdictCard verdict={verdict} />
                </div>
              ) : status === "streaming" && bearPoints.length > 0 ? (
                <div className="flex items-center justify-center h-full border border-dashed rounded-2xl bg-muted/20 text-muted-foreground animate-pulse py-12">
                  <div className="flex flex-col items-center gap-3">
                    <LoaderCircle className="h-6 w-6 animate-spin" />
                    <p className="text-sm font-medium">Jury is evaluating arguments and calculating final verdict...</p>
                  </div>
                </div>
              ) : status === "error" && (bullPoints.length > 0 || bearPoints.length > 0) ? (
                <div className="flex items-center justify-center h-full border border-dashed border-rose-500/30 rounded-2xl bg-rose-500/5 text-rose-600/80 py-12">
                  <div className="flex flex-col items-center gap-3">
                    <CircleAlert className="h-6 w-6" />
                    <p className="text-sm font-medium">Connection lost before final verdict.</p>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
      
      <ConsentDialog
        open={showConsent}
        request={consentRequest}
        onGrant={async () => {
          setShowConsent(false);
          startDebate(true);
        }}
        onDeny={() => {
          setShowConsent(false);
          if (status === "consent_required" || status === "idle") {
            setStatus("idle");
          }
        }}
      />
    </SurfaceInset>
  );
}
