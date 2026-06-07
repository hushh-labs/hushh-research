"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { TrendingUp, ShieldAlert, Crown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";

interface TrinityCardsProps {
  bullCase?: string;
  bearCase?: string;
  renaissanceVerdict?: string;
}

export function TrinityCards({ bullCase, bearCase, renaissanceVerdict }: TrinityCardsProps) {
  // If no data yet, don't render anything to avoid clutter
  if (!bullCase && !bearCase && !renaissanceVerdict) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-in fade-in slide-in-from-bottom-4 ">
      
      {/* 1. THE PERSONALIZED BULL */}
      <Card className={cn("border-emerald-500/20 bg-emerald-500/5", !bullCase && "opacity-50")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
            <Icon icon={TrendingUp} size="sm" aria-hidden="true" />
            Personalized Bull Case
          </CardTitle>
        </CardHeader>
        <CardContent>
          {bullCase ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {bullCase}
            </p>
          ) : (
            <div className="h-20 flex items-center justify-center text-xs text-muted-foreground/50 italic">
              Analyzing upside potential for your portfolio...
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. THE PERSONALIZED BEAR */}
      <Card className={cn("border-rose-500/20 bg-rose-500/5", !bearCase && "opacity-50")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-rose-600 dark:text-rose-400 flex items-center gap-2">
            <Icon icon={ShieldAlert} size="sm" aria-hidden="true" />
            Personalized Bear Case
          </CardTitle>
        </CardHeader>
        <CardContent>
          {bearCase ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {bearCase}
            </p>
          ) : (
            <div className="h-20 flex items-center justify-center text-xs text-muted-foreground/50 italic">
              Identifying risks to your specific holdings...
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. THE RENAISSANCE VERDICT */}
      <Card className={cn("border-violet-500/20 bg-violet-500/5", !renaissanceVerdict && "opacity-50")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-violet-600 dark:text-violet-400 flex items-center gap-2">
            <Icon icon={Crown} size="sm" className="text-amber-500" aria-hidden="true" />
            Renaissance Verdict
          </CardTitle>
        </CardHeader>
        <CardContent>
          {renaissanceVerdict ? (
            <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {renaissanceVerdict}
            </div>
          ) : (
            <div className="h-20 flex items-center justify-center text-xs text-muted-foreground/50 italic">
              Calculating FCF & Tier Status...
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
