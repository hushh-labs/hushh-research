import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function GoldPeriod({
  children = ".",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return <span className={cn("gold-period", className)}>{children}</span>;
}

export function OneLockup({ className }: { className?: string }) {
  return (
    <span className={className}>
      One
      <GoldPeriod />
    </span>
  );
}
