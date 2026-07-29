"use client";

import { useRef, useEffect } from "react";
import { PenTool, X, Download } from "lucide-react";
import { useScratchpad } from "@/lib/hooks/use-scratchpad";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ScratchpadWidget() {
  const { content, isOpen, isInitialized, updateContent, toggleOpen, closeScratchpad } = useScratchpad();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when opened
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      // Small timeout to allow transition to finish
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        closeScratchpad();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeScratchpad]);

  if (!isInitialized) return null;

  const handleDownload = () => {
    if (!content.trim()) return;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scratchpad-${new Date().toISOString().split("T")[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3 pointer-events-none">
      {/* Popover Window */}
      <div 
        className={`pointer-events-auto origin-bottom-right transition-all duration-200 ease-out flex flex-col bg-background/80 backdrop-blur-xl border shadow-2xl rounded-2xl w-[320px] sm:w-[380px] overflow-hidden ${
          isOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 translate-y-4 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <PenTool className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium tracking-tight">Quick Note</span>
          </div>
          <div className="flex items-center gap-1">
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-7 w-7 rounded-full" 
              onClick={handleDownload}
              disabled={!content.trim()}
              title="Download text"
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground" 
              onClick={closeScratchpad}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
        
        <div className="p-3">
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => updateContent(e.target.value)}
            placeholder="Jot down a quick thought, paste a temporary key, or draft a message... (Auto-saves locally)"
            className="min-h-[220px] resize-y border-0 bg-transparent focus-visible:ring-0 px-1 py-1 shadow-none rounded-none w-full"
            spellCheck={false}
          />
        </div>
        
        <div className="px-4 py-2 text-[10px] text-muted-foreground flex justify-between items-center bg-muted/10 border-t">
          <span>{content.length} chars</span>
          <span>Saved locally</span>
        </div>
      </div>

      {/* Floating Action Button */}
      <Button
        variant="default"
        size="icon"
        onClick={toggleOpen}
        className={`pointer-events-auto h-12 w-12 rounded-full shadow-lg transition-transform duration-200 ${isOpen ? "rotate-90 scale-90 opacity-0" : "hover:scale-105"}`}
        title="Open Scratchpad"
      >
        <PenTool className="w-5 h-5" />
      </Button>
    </div>
  );
}
