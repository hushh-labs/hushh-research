"use client";

import { useEffect, useState } from "react";

interface CountdownChipProps {
  endsAt: string;
}

function formatTimeLeft(ms: number): string {
  if (ms <= 0) return "Ended";
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h left`;
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

export function CountdownChip({ endsAt }: CountdownChipProps) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function update() {
      const ms = new Date(endsAt).getTime() - Date.now();
      setTimeLeft(formatTimeLeft(ms));
    }
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [endsAt]);

  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      {timeLeft}
    </span>
  );
}
