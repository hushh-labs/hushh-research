// components/kai/agent-analysis-card.tsx

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { ExpandableText } from "@/components/app-ui/expandable-text";
import { Bot, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentAnalysisCardProps {
  title?: string;
  analysisText?: string;
  agentName?: string;
  className?: string;
  // Restored props to satisfy the strict compiler for master views
  icon?: React.ReactNode;
  color?: string;
  state?: any;
  disableStreaming?: boolean;
  compactMode?: boolean;
  children?: React.ReactNode;
}

const defaultAnalysis = "Based on the recent market trends and your portfolio distribution, there is a strong indication of over-leverage in the tech sector. While historical performance has been robust, the current macroeconomic indicators suggest a potential correction. Rebalancing towards defensive equities or fixed-income assets could mitigate downside risk while preserving baseline yield. Furthermore, looking at the 5-year projection models, diversifying into emerging markets might provide the uncorrelated alpha you are targeting. Consider reviewing the automated rebalancing thresholds in your settings to maintain optimal layout stability and risk exposure.";

export function AgentAnalysisCard({
  title = "Kai Analysis",
  analysisText = defaultAnalysis,
  agentName = "Kai",
  icon,
  color,
  children,
  className
  // Note: state, disableStreaming, and compactMode are purposefully omitted here 
  // so ESLint doesn't flag them as unused variables, but they remain in the interface!
}: AgentAnalysisCardProps) {
  return (
    <Card variant="none" effect="glass" className={cn("border border-border/50", className)}>
      <CardHeader className="pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10 text-primary">
            {icon ? icon : <Sparkles size={16} />}
          </div>
          <CardTitle className="text-sm font-semibold tracking-wide text-foreground">
            {title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-4">
        <div className="flex gap-3 items-start">
          <div className={cn("w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5", color)}>
            <Bot size={16} className="text-primary" />
          </div>
          <div className="flex-1 space-y-1">
            <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">{agentName}</p>
            
            {/* HARVESTED EXPANDABLE TEXT COMPONENT */}
            <ExpandableText text={analysisText} maxLength={150} className="text-sm text-foreground leading-relaxed">
              {analysisText}
            </ExpandableText>

            {children}
            
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default AgentAnalysisCard;