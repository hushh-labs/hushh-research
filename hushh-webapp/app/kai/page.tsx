import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { KaiMarketPreviewView } from "@/components/kai/views/kai-market-preview-view";
import { Suspense } from "react";
import { Activity, ShieldCheck, Zap, Globe2, Cpu, Lock, BarChart3, TrendingUp } from "lucide-react";

// Advanced Skeleton Loader for Dark Mode
function KaiLoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-32 space-y-8">
      <div className="relative flex justify-center items-center w-32 h-32">
        <div className="absolute inset-0 border-[1px] border-indigo-500/30 rounded-full animate-[spin_4s_linear_infinite]"></div>
        <div className="absolute inset-2 border-[1px] border-purple-500/40 rounded-full animate-[spin_3s_linear_infinite_reverse]"></div>
        <div className="absolute inset-4 border-[2px] border-indigo-500 rounded-full border-t-transparent animate-spin"></div>
        <Cpu className="w-8 h-8 text-indigo-400 animate-pulse" />
      </div>
      <div className="text-center space-y-2 animate-pulse">
        <h3 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 tracking-wide">
          INITIALIZING NEURAL LINK...
        </h3>
        <p className="text-sm text-neutral-400 font-mono">Establishing secure handshake with Sovereignty Engine</p>
      </div>
    </div>
  );
}

// Sparkline SVG Component for visual flair
function Sparkline({ color }: { color: string }) {
  return (
    <svg className="w-full h-12" viewBox="0 0 100 30" preserveAspectRatio="none">
      <path
        d="M0 25 Q 10 15, 20 20 T 40 10 T 60 25 T 80 5 T 100 15"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-[dash_3s_linear_infinite]"
        strokeDasharray="200"
        strokeDashoffset="0"
      />
      <style>{`
        @keyframes dash {
          to { stroke-dashoffset: -200; }
        }
      `}</style>
    </svg>
  );
}

export default function KaiPage() {
  const currentDate = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="relative min-h-screen w-full bg-[#0a0a0a] text-neutral-50 selection:bg-indigo-500/30 font-sans overflow-x-hidden">
      <NativeRouteMarker routeId="/kai" marker="native-route-kai-home" authState="authenticated" dataState="loaded" />
      <NativeTestBeacon routeId="/kai" marker="native-route-kai-home" authState="authenticated" dataState="loaded" />

      {/* Extreme Background Effects */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        {/* Dark grid background */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff05_1px,transparent_1px),linear-gradient(to_bottom,#ffffff05_1px,transparent_1px)] bg-[size:40px_40px]"></div>
        {/* Glowing Orbs */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-indigo-600/10 blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-purple-600/10 blur-[120px]"></div>
        {/* Vignette */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,#0a0a0a_100%)]"></div>
      </div>

      <main className="relative z-10 flex-1 px-4 sm:px-6 lg:px-8 pt-8 pb-24 max-w-[1400px] mx-auto">
        <section className="space-y-10 animate-in fade-in slide-in-from-bottom-12 duration-1000 ease-out">
          
          {/* Top Bar Navigation */}
          <nav className="flex items-center justify-between border border-white/10 bg-black/40 backdrop-blur-2xl rounded-2xl p-4 shadow-[0_0_40px_-10px_rgba(79,70,229,0.15)]">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-500/20 rounded-lg border border-indigo-500/30">
                <Globe2 className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-widest text-white uppercase">Hushh <span className="text-indigo-400">Kai</span></h1>
                <p className="text-[10px] text-neutral-400 font-mono tracking-widest uppercase">Global Sovereignty Network</p>
              </div>
            </div>
            
            <div className="hidden md:flex items-center gap-6">
              <div className="flex items-center gap-2 text-xs font-mono text-neutral-400 bg-white/5 px-3 py-1.5 rounded-full border border-white/5">
                <ClockIcon className="w-3.5 h-3.5" />
                <span>{currentDate}</span>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-full border border-emerald-500/20 shadow-[0_0_15px_-3px_rgba(16,185,129,0.2)]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                SYSTEM ONLINE
              </div>
            </div>
          </nav>

          {/* Hero Header */}
          <div className="text-center py-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-mono mb-6">
              <Zap className="w-3 h-3 text-indigo-400" />
              <span>KAI INTELLIGENCE v2.0 ACTIVE</span>
            </div>
            <h2 className="text-5xl md:text-7xl font-black tracking-tighter text-white mb-4">
              Market <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 drop-shadow-[0_0_30px_rgba(129,140,248,0.3)]">Intelligence</span>
            </h2>
            <p className="text-neutral-400 text-lg md:text-xl max-w-2xl mx-auto font-light">
              Real-time cryptographic analysis of global market conditions, powered by the Hushh Sovereignty Engine.
            </p>
          </div>

          {/* Bento Box Grid Layout */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 md:gap-6">
            
            {/* Stat Card 1 */}
            <div className="group relative bg-[#111111] border border-white/5 hover:border-indigo-500/30 rounded-3xl p-6 transition-all duration-500 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="flex justify-between items-start mb-6">
                <div className="p-3 bg-black rounded-xl border border-white/5 shadow-inner">
                  <Activity className="w-5 h-5 text-indigo-400" />
                </div>
                <span className="text-emerald-400 text-xs font-mono flex items-center gap-1 bg-emerald-400/10 px-2 py-1 rounded-md">
                  +14.2% <TrendingUp className="w-3 h-3" />
                </span>
              </div>
              <p className="text-neutral-500 text-sm font-medium mb-1">Global Active Nodes</p>
              <h3 className="text-3xl font-bold text-white font-mono">1,048,291</h3>
              <div className="mt-4 opacity-50 group-hover:opacity-100 transition-opacity duration-500">
                <Sparkline color="#818cf8" />
              </div>
            </div>

            {/* Stat Card 2 */}
            <div className="group relative bg-[#111111] border border-white/5 hover:border-purple-500/30 rounded-3xl p-6 transition-all duration-500 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="flex justify-between items-start mb-6">
                <div className="p-3 bg-black rounded-xl border border-white/5 shadow-inner">
                  <Lock className="w-5 h-5 text-purple-400" />
                </div>
                <span className="text-emerald-400 text-xs font-mono bg-emerald-400/10 px-2 py-1 rounded-md">
                  SECURE
                </span>
              </div>
              <p className="text-neutral-500 text-sm font-medium mb-1">Encryption Layer</p>
              <h3 className="text-3xl font-bold text-white font-mono">AES-256-GCM</h3>
              <div className="mt-4 opacity-50 group-hover:opacity-100 transition-opacity duration-500">
                <Sparkline color="#c084fc" />
              </div>
            </div>

            {/* Main Application Window (Spans 2 columns on desktop) */}
            <div className="md:col-span-2 relative bg-[#111111] border border-white/10 rounded-3xl overflow-hidden shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] group flex flex-col">
              {/* Glass Header for the App Window */}
              <div className="px-6 py-4 border-b border-white/5 bg-white/[0.02] flex items-center justify-between backdrop-blur-xl">
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
                  </div>
                  <div className="h-4 w-px bg-white/10 mx-2"></div>
                  <h2 className="text-sm font-bold text-neutral-200 tracking-wide flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-indigo-400" />
                    Market Preview Engine
                  </h2>
                </div>
                <button className="text-xs font-mono text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1 bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20 hover:bg-indigo-500/20">
                  <Activity className="w-3 h-3" /> Live Feed
                </button>
              </div>

              {/* The Actual Component content */}
              <div className="relative p-2 sm:p-6 min-h-[450px] flex-1 flex flex-col bg-black/20">
                <Suspense fallback={<KaiLoadingState />}>
                   {/* We wrap the inner view to isolate its styles if it assumes a light mode, but let's assume it inherits gracefully or stands out as a widget */}
                   <div className="animate-in fade-in zoom-in-95 duration-1000 delay-300 h-full w-full">
                     <KaiMarketPreviewView />
                   </div>
                </Suspense>
              </div>
              
              {/* Subtle inner glow effect */}
              <div className="absolute inset-0 border border-white/5 rounded-3xl pointer-events-none group-hover:border-indigo-500/20 transition-colors duration-700"></div>
            </div>

          </div>

          <footer className="text-center pt-16 pb-8">
            <div className="inline-flex items-center gap-2 text-neutral-500 text-xs font-mono border border-white/5 bg-white/[0.02] px-4 py-2 rounded-full">
              <ShieldCheck className="w-4 h-4" />
              <span>Intelligence mathematically verified by Hushh</span>
            </div>
          </footer>

        </section>
      </main>
    </div>
  );
}

// Helper icon component
function ClockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}
