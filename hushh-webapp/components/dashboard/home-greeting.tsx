"use client";

import { useEffect, useState } from "react";

/**
 * Derive a friendly first name for the greeting. Accepts a display name or an
 * email and never greets someone by their raw address ("manish.sainani@…") or
 * by a name carrying trailing digits.
 */
export function friendlyFirstName(displayName?: string | null): string | null {
  const raw = String(displayName ?? "").trim();
  if (!raw) return null;
  const base = raw.includes("@") ? (raw.split("@")[0] ?? raw) : raw;
  const token = base.split(/[\s._-]+/).filter(Boolean)[0] ?? base;
  const cleaned = token.replace(/[0-9]+/g, "").trim();
  if (!cleaned) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * A calm, personal home greeting in One's voice (attentive, quietly competent).
 *
 * Deliberately a single warm line — not the hero block that was previously
 * removed from this surface. Time-of-day reflects the user's *local* clock, so
 * it resolves on the client after mount; before that it shows a neutral,
 * non-time lead to avoid a server-timezone mismatch or a hydration flash.
 */
export function HomeGreeting({
  displayName,
  subline,
}: {
  displayName?: string | null;
  subline?: string;
}) {
  const [greeting, setGreeting] = useState<string | null>(null);
  useEffect(() => {
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);

  const name = friendlyFirstName(displayName);
  const lead = greeting ?? "Welcome back";

  return (
    <header className="space-y-1">
      <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-foreground sm:text-[26px]">
        {lead}
        {name ? `, ${name}` : ""}.
      </h1>
      {subline ? (
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          {subline}
        </p>
      ) : null}
    </header>
  );
}
