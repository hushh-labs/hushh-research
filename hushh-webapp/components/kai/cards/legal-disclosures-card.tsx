"use client";

import { useState, useMemo } from "react";
import { FileText, ChevronDown, ChevronUp, Shield, Scale } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

// =============================================================================
// TYPES & CONFIG
// =============================================================================

export interface LegalDisclosuresCardProps {
  disclosures?: string[];
  className?: string;
}

const CATEGORIES = {
  PATRIOT: { label: "USA PATRIOT Act", icon: Shield, priority: 1 },
  SIPC: { label: "SIPC Protection", icon: Shield, priority: 2 },
  FDIC: { label: "FDIC Insurance", icon: Shield, priority: 3 },
  PRIVACY: { label: "Privacy Notice", icon: Scale, priority: 4 },
  RISK: { label: "Risk Disclosure", icon: Scale, priority: 5 },
  GENERAL: { label: "General Disclosure", icon: FileText, priority: 10 },
} as const;

// Memoize helper to avoid re-creation
const categorizeDisclosure = (text: string) => {
  const lower = text.toLowerCase();
  if (lower.includes("patriot")) return CATEGORIES.PATRIOT;
  if (lower.includes("sipc")) return CATEGORIES.SIPC;
  if (lower.includes("fdic")) return CATEGORIES.FDIC;
  if (lower.includes("privacy")) return CATEGORIES.PRIVACY;
  if (lower.includes("risk")) return CATEGORIES.RISK;
  return CATEGORIES.GENERAL;
};

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function DisclosureItem({ text }: { text: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const meta = useMemo(() => categorizeDisclosure(text), [text]);
  const isExpandable = text.length > 150;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn(
        "border rounded-lg overflow-hidden transition-all",
        isOpen ? "border-primary/20 bg-muted/20" : "border-border/50 hover:border-border"
      )}>
        <CollapsibleTrigger asChild disabled={!isExpandable}>
          <button
            className="w-full p-3 flex items-start gap-3 text-left transition-colors"
            aria-expanded={isOpen}
          >
            <div className={cn("p-1.5 rounded-lg shrink-0 mt-0.5", meta.priority <= 3 ? "bg-primary/10" : "bg-muted")}>
              <Icon icon={meta.icon} size="sm" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-semibold">{meta.label}</span>
                {meta.priority <= 3 && <Badge variant="outline" className="text-[9px] px-1 py-0 border-primary/20 text-primary">Important</Badge>}
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{text}</p>
            </div>
            {isExpandable && (
              <Icon icon={isOpen ? ChevronUp : ChevronDown} size="sm" className="shrink-0 text-muted-foreground mt-1" />
            )}
          </button>
        </CollapsibleTrigger>

        {isExpandable && (
          <CollapsibleContent>
            <div className="px-3 pb-3 pt-0 animate-in slide-in-from-top-1 fade-in duration-200">
              <div className="bg-background rounded-md p-3 border border-border/30">
                <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{text}</p>
              </div>
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function LegalDisclosuresCard({ disclosures = [], className }: LegalDisclosuresCardProps) {
  const [showAll, setShowAll] = useState(false);

  const sortedDisclosures = useMemo(() => {
    return [...disclosures].sort((a, b) => categorizeDisclosure(a).priority - categorizeDisclosure(b).priority);
  }, [disclosures]);

  const displayList = showAll ? sortedDisclosures : sortedDisclosures.slice(0, 3);

  return (
    <Card className={cn("w-full shadow-sm", className)}>
      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon icon={Scale} size="md" className="text-muted-foreground" />
            <CardTitle className="text-base font-semibold">Legal Disclosures</CardTitle>
          </div>
          <Badge variant="secondary" className="text-xs px-2 py-0.5">{disclosures.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {displayList.map((d, i) => <DisclosureItem key={i} text={d} />)}

        {disclosures.length > 3 && (
          <Button
            variant="none"
            size="sm"
            onClick={() => setShowAll(!showAll)}
            className="w-full text-xs font-medium text-muted-foreground hover:bg-muted"
          >
            <Icon icon={showAll ? ChevronUp : ChevronDown} size="xs" className="mr-1.5" />
            {showAll ? "Show less" : `Show ${disclosures.length - 3} more disclosures`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}