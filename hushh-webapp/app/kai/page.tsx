"use client";

import { useState } from "react";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { KaiMarketPreviewView } from "@/components/kai/views/kai-market-preview-view";

// Extracted the exact type component properties expect directly from the component itself
type DataStateProps = React.ComponentProps<typeof NativeTestBeacon>["dataState"];

export default function KaiPage() {
  // Page Interactive States with safe type-matching
  const [searchQuery, setSearchQuery] = useState("");
  const [currentDataState, setCurrentDataState] = useState<DataStateProps>("loaded");
  const [isSyncing, setIsSyncing] = useState(false);

  // Quick Stats Mock Data
  const systemStats = [
    { label: "Active Connections", value: "1,248", change: "+12%", type: "emerald" },
    { label: "Route Latency", value: "24ms", change: "Optimal", type: "blue" },
    { label: "Beacons Tracked", value: "43,901", change: "+412 today", type: "teal" },
  ];

  // Handler to simulate syncing data state updates using correct types
  const handleRefreshData = () => {
    setIsSyncing(true);
    setCurrentDataState("loading");
    setTimeout(() => {
      setIsSyncing(false);
      setCurrentDataState("loaded");
    }, 1200);
  };

  return (
    <>
      {/* Dynamic tracking markers hooked up to safely typed states */}
      <NativeRouteMarker
        routeId="/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState={currentDataState}
      />

      <NativeTestBeacon
        routeId="/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState={currentDataState}
      />

      {/* Main Page Layout Container */}
      <main className="min-h-screen bg-background p-6 md:p-10 text-foreground transition-colors duration-200">
        <div className="max-w-7xl mx-auto space-y-8">
          
          {/* Top Navbar Section */}
          <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border pb-6">
            <div>
              <h1 className="text-3xl font-heading font-bold tracking-tight text-hushh-blue-500 dark:text-hushh-blue-400">
                Kai Engine Management
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Monitor live telemetry metrics, process system routes, and audit platform marketplace state.
              </p>
            </div>
            
            {/* System Status Controls */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleRefreshData}
                disabled={isSyncing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                <svg
                  className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.253 8H18" />
                </svg>
                {isSyncing ? "Syncing..." : "Sync Signals"}
              </button>
            </div>
          </header>

          {/* Feature 1: Live Status Metrics Bar */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-5" aria-label="System Metrics">
            {systemStats.map((stat, idx) => (
              <div key={idx} className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stat.label}</p>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold tracking-tight">{stat.value}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                    stat.type === 'emerald' 
                      ? 'bg-hushh-emerald-50 text-hushh-emerald-600 dark:bg-hushh-emerald-900/20 dark:text-hushh-emerald-400' 
                      : 'bg-hushh-blue-50 text-hushh-blue-600 dark:bg-hushh-blue-900/20 dark:text-hushh-blue-400'
                  }`}>
                    {stat.change}
                  </span>
                </div>
              </div>
            ))}
          </section>

          {/* Control & Search Toolbar Layout */}
          <section className="bg-card border border-border rounded-xl p-4 shadow-sm flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <span className="text-xs font-medium text-muted-foreground mr-2">Telemetry Filter State:</span>
              <div className="flex gap-1.5 p-1 bg-muted rounded-lg text-xs">
                <button 
                  onClick={() => setCurrentDataState("loaded")} 
                  className={`px-3 py-1 rounded-md font-medium ${currentDataState === 'loaded' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'}`}
                >
                  Loaded State
                </button>
                <button 
                  onClick={() => setCurrentDataState("loading")} 
                  className={`px-3 py-1 rounded-md font-medium ${currentDataState === 'loading' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'}`}
                >
                  Loading State
                </button>
              </div>
            </div>

            {/* Local Client Filtering Field */}
            <div className="relative w-full md:w-80">
              <input
                type="text"
                placeholder="Search view metrics..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-3 pr-4 py-2 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring transition-all"
              />
            </div>
          </section>

          {/* Primary Main View & Split Side Workspace */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            
            {/* Left 2 Columns: Core Marketplace Intelligence Feed */}
            <section className="lg:col-span-2 bg-card border border-border rounded-xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-heading font-semibold text-foreground">Marketplace Intelligence Preview</h2>
                  <p className="text-xs text-muted-foreground">Live analytical assets compiled directly from downstream frameworks.</p>
                </div>
                <span className="text-xs bg-muted border border-border px-2.5 py-1 rounded-md font-medium">
                  {currentDataState.toUpperCase()}
                </span>
              </div>
              
              <div className="rounded-lg bg-background/40 border border-border/50 p-1">
                <KaiMarketPreviewView />
              </div>
            </section>

            {/* Right Column: Engine Configurations Drawer */}
            <aside className="space-y-6">
              <div className="bg-card border border-border rounded-xl p-6 shadow-sm space-y-4">
                <h3 className="text-sm font-heading font-bold uppercase tracking-wider text-muted-foreground">
                  Quick System Tasks
                </h3>
                
                <div className="flex flex-col gap-2.5">
                  <button className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-muted/50 hover:border-hushh-blue-400 transition-all text-sm group">
                    <div className="font-semibold group-hover:text-hushh-blue-500">Run Node Diagnosis</div>
                    <div className="text-xs text-muted-foreground mt-0.5">Audit component runtime configurations.</div>
                  </button>
                  
                  <button className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-muted/50 hover:border-hushh-emerald-400 transition-all text-sm group">
                    <div className="font-semibold group-hover:text-hushh-emerald-500">Flush Trace Beacons</div>
                    <div className="text-xs text-muted-foreground mt-0.5">Purge locally saved logging queues safely.</div>
                  </button>
                </div>
              </div>

              {/* Connected Credentials Indicator */}
              <div className="rounded-xl bg-gradient-to-br from-hushh-navy-500 to-hushh-navy-600 p-5 text-white shadow-md">
                <h4 className="font-medium text-sm">Security & Governance Signature</h4>
                <p className="text-xs text-slate-300 mt-1">This node workspace uses signed DCO declarations. All trace interactions are logged automatically.</p>
                <div className="mt-4 pt-4 border-t border-white/10 flex items-center justify-between text-xs text-slate-200">
                  <span>ID: priya-hushh-node</span>
                  <span className="font-mono px-1.5 py-0.5 bg-white/10 rounded">v1.1.0</span>
                </div>
              </div>
            </aside>

          </div>

        </div>
      </main>
    </>
  );
}