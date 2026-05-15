"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";

export type PrivacyPolicyLevel = "strict" | "relaxed" | "none";

interface PrivacyScreenGuardProps {
  policy?: PrivacyPolicyLevel;
}

export function PrivacyScreenGuard({ policy = "strict" }: PrivacyScreenGuardProps) {
  const [isObscured, setIsObscured] = useState(false);

  useEffect(() => {
    if (policy === "none") {
      setIsObscured(false);
      return;
    }

    // 1. Browser Visibility Proof (Tab switching/minimizing)
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setIsObscured(true);
      } else {
        setIsObscured(false);
      }
    };

    // 2. Mobile Visibility Proof (Capacitor/Cordova backgrounding)
    const onPause = () => setIsObscured(true);
    const onResume = () => setIsObscured(false);

    // 3. Strict Mode Extension (Obscures even if visible but out of focus)
    const handleBlur = () => {
      if (policy === "strict") setIsObscured(true);
    };
    const handleFocus = () => {
      if (policy === "strict") setIsObscured(false);
    };

    // Attach Listeners
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("pause", onPause, false);
    document.addEventListener("resume", onResume, false);
    
    if (policy === "strict") {
      window.addEventListener("blur", handleBlur);
      window.addEventListener("focus", handleFocus);
    }

    return () => {
      // Cleanup
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("pause", onPause);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, [policy]);

  if (!isObscured) return null;

  return (
    <div className="fixed inset-0 z-[99999] flex flex-col items-center justify-center bg-background/95 backdrop-blur-2xl transition-all duration-150">
      <Shield className="h-16 w-16 text-muted-foreground mb-6 animate-pulse" />
      <h2 className="text-2xl font-semibold text-foreground tracking-tight">Privacy Guard Active</h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-sm text-center">
        Screen obscured to prevent shoulder surfing. Click or return to the app to resume.
      </p>
    </div>
  );
}
