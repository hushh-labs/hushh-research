"use client";

import { MessageSquarePlus, X, Loader2, Bug, Lightbulb, MessageCircle } from "lucide-react";
import { useFeedbackForm } from "@/lib/hooks/use-feedback-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function FeedbackWidget() {
  const { 
    isOpen, 
    isSubmitting, 
    type, 
    message, 
    setIsOpen, 
    setType, 
    setMessage, 
    submitFeedback 
  } = useFeedbackForm();

  return (
    <div className="fixed bottom-[100px] right-6 z-50 flex flex-col items-end gap-3 pointer-events-none">
      {/* Popover Window */}
      <div 
        className={`pointer-events-auto origin-bottom-right transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] flex flex-col bg-background/90 backdrop-blur-2xl border shadow-2xl rounded-2xl w-[320px] overflow-hidden ${
          isOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 translate-y-4 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <MessageSquarePlus className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium tracking-tight">Send Feedback</span>
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
        
        <div className="p-4 flex flex-col gap-4">
          <div className="flex bg-muted/50 p-1 rounded-lg w-full">
            <Button 
              variant={type === "bug" ? "default" : "ghost"} 
              size="sm" 
              className="flex-1 h-8 text-[11px]"
              onClick={() => setType("bug")}
            >
              <Bug className="w-3 h-3 mr-1.5" /> Bug
            </Button>
            <Button 
              variant={type === "feature" ? "default" : "ghost"} 
              size="sm" 
              className="flex-1 h-8 text-[11px]"
              onClick={() => setType("feature")}
            >
              <Lightbulb className="w-3 h-3 mr-1.5" /> Idea
            </Button>
            <Button 
              variant={type === "general" ? "default" : "ghost"} 
              size="sm" 
              className="flex-1 h-8 text-[11px]"
              onClick={() => setType("general")}
            >
              <MessageCircle className="w-3 h-3 mr-1.5" /> Other
            </Button>
          </div>

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              type === "bug" ? "What went wrong?" 
              : type === "feature" ? "What should we build next?" 
              : "Tell us what you think..."
            }
            className="min-h-[120px] resize-none text-sm bg-background"
            disabled={isSubmitting}
          />

          <Button 
            variant="default" 
            className="w-full h-10 shadow-md"
            onClick={submitFeedback}
            disabled={isSubmitting || !message.trim()}
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {isSubmitting ? "Sending..." : "Submit Feedback"}
          </Button>
        </div>
      </div>

      {/* Floating Action Button */}
      <Button
        variant="outline"
        size="icon"
        onClick={() => setIsOpen(!isOpen)}
        className={`pointer-events-auto h-12 w-12 rounded-full shadow-[0_4px_14px_0_rgba(0,0,0,0.1)] border transition-all duration-300 bg-background/80 backdrop-blur ${isOpen ? "rotate-90 scale-90 opacity-0" : "hover:scale-105 hover:shadow-[0_6px_20px_rgba(0,0,0,0.15)]"}`}
        title="Provide Feedback"
      >
        <MessageSquarePlus className="w-5 h-5 text-foreground" />
      </Button>
    </div>
  );
}
