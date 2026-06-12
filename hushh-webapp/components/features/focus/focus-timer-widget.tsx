"use client";

import { useEffect } from "react";
import { Timer, Play, Pause, RotateCcw, X, Coffee, Brain } from "lucide-react";
import { useFocusTimer } from "@/lib/hooks/use-focus-timer";
import { Button } from "@/components/ui/button";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function FocusTimerWidget() {
  const { 
    isOpen, 
    timeLeft, 
    isRunning, 
    mode, 
    sessionsCompleted,
    setIsOpen, 
    toggleTimer, 
    resetTimer, 
    setMode,
    tick 
  } = useFocusTimer();

  useEffect(() => {
    const interval = setInterval(() => {
      tick();
    }, 1000);
    return () => clearInterval(interval);
  }, [tick]);

  const progressPercent = mode === "pomodoro" 
    ? 100 - (timeLeft / (25 * 60)) * 100 
    : mode === "shortBreak"
    ? 100 - (timeLeft / (5 * 60)) * 100
    : 100 - (timeLeft / (15 * 60)) * 100;

  return (
    <div className="fixed bottom-6 left-6 z-50 flex flex-col items-start gap-3 pointer-events-none">
      {/* Popover Window */}
      <div 
        className={`pointer-events-auto origin-bottom-left transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] flex flex-col bg-background/80 backdrop-blur-2xl border shadow-2xl rounded-2xl w-[300px] overflow-hidden ${
          isOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 translate-y-4 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium tracking-tight">Focus Timer</span>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground" 
            onClick={() => setIsOpen(false)}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
        
        <div className="p-5 flex flex-col items-center">
          <div className="flex gap-1 bg-muted p-1 rounded-lg w-full mb-6">
            <Button 
              variant={mode === "pomodoro" ? "default" : "ghost"} 
              size="sm" 
              className="flex-1 h-8 text-[11px]"
              onClick={() => setMode("pomodoro")}
            >
              Focus
            </Button>
            <Button 
              variant={mode === "shortBreak" ? "default" : "ghost"} 
              size="sm" 
              className="flex-1 h-8 text-[11px]"
              onClick={() => setMode("shortBreak")}
            >
              Break
            </Button>
          </div>

          <div className="relative flex items-center justify-center w-40 h-40 mb-6">
            <svg className="absolute w-full h-full -rotate-90">
              <circle
                cx="80"
                cy="80"
                r="76"
                className="stroke-muted fill-none"
                strokeWidth="6"
              />
              <circle
                cx="80"
                cy="80"
                r="76"
                className="stroke-primary fill-none transition-all duration-1000 ease-linear"
                strokeWidth="6"
                strokeDasharray="477.5"
                strokeDashoffset={477.5 - (477.5 * progressPercent) / 100}
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute flex flex-col items-center">
              <span className="text-4xl font-light font-mono tracking-tighter">
                {formatTime(timeLeft)}
              </span>
              <span className="text-[10px] text-muted-foreground mt-1 uppercase tracking-widest flex items-center gap-1">
                {mode === "pomodoro" ? <><Brain className="w-3 h-3" /> Focus</> : <><Coffee className="w-3 h-3" /> Break</>}
              </span>
            </div>
          </div>

          <div className="flex gap-3 w-full">
            <Button 
              variant={isRunning ? "secondary" : "default"} 
              className="flex-1 rounded-xl"
              onClick={toggleTimer}
            >
              {isRunning ? <Pause className="w-4 h-4 mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              {isRunning ? "Pause" : "Start"}
            </Button>
            <Button 
              variant="outline" 
              size="icon" 
              className="rounded-xl w-10 shrink-0"
              onClick={resetTimer}
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>
        </div>
        
        <div className="px-4 py-2.5 text-[11px] text-muted-foreground flex justify-between items-center bg-muted/20 border-t">
          <span>Sessions completed</span>
          <span className="font-semibold text-foreground px-2 py-0.5 bg-muted rounded-md">{sessionsCompleted}</span>
        </div>
      </div>

      {/* Floating Action Button */}
      <Button
        variant="secondary"
        size="icon"
        onClick={() => setIsOpen(!isOpen)}
        className={`pointer-events-auto h-12 w-12 rounded-full shadow-lg border transition-all duration-300 ${isOpen ? "rotate-90 scale-90 opacity-0" : "hover:scale-105"}`}
        title="Open Focus Timer"
      >
        <Timer className="w-5 h-5" />
        {isRunning && (
          <span className="absolute -top-1 -right-1 flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
          </span>
        )}
      </Button>
    </div>
  );
}
