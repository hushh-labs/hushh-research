"use client";

import { useEffect, useState } from "react";

/**
 * A warm, personal home greeting — the first thing that makes /one feel like the
 * user's own agent rather than an app launcher. Renders the user's name
 * immediately (deterministic on the server), then refines to a time-of-day
 * greeting after mount so there is no hydration mismatch.
 *
 * Honest by design: it establishes One's presence and the ownership principle
 * (private, consent-first, yours) without overclaiming a live per-user pod, which
 * is a separate, flag-gated capability.
 */

export function friendlyFirstName(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) return "there";

  // An email (no spaces, has "@"): use the local part's first token.
  if (!value.includes(" ") && value.includes("@")) {
    const local = value.split("@", 1)[0] ?? "";
    const token = local.split(/[._-]+/).filter(Boolean)[0] ?? "";
    return token ? token.charAt(0).toUpperCase() + token.slice(1) : "there";
  }

  const first = value.split(/\s+/)[0] ?? "";
  return first || "there";
}

export function timeOfDayGreeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function OneHomeGreeting({ displayName }: { displayName?: string | null }) {
  // Deterministic on first paint (server + hydration); refined client-side.
  const [greeting, setGreeting] = useState("Welcome back");

  useEffect(() => {
    setGreeting(timeOfDayGreeting(new Date()));
  }, []);

  const name = friendlyFirstName(displayName);

  return (
    <header className="pt-1">
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-foreground sm:text-[26px]">
        {greeting}, {name}.
      </h1>
    </header>
  );
}
