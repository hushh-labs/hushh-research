// components/kai/cards/legal-disclosures-card.tsx

/**
 * Legal Disclosures Card - Extracted legal text and disclaimers
 *
 * Features:
 * - Collapsible sections for each disclosure
 * - Full verbatim text preservation
 * - USA PATRIOT ACT notices
 * - SIPC information
 * - Responsive and mobile-friendly
 */

"use client";

import { useState } from "react";
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
// TYPES
// =============================================================================

interface LegalDisclosuresCardProps {
  disclosures?: string[];
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function categorizeDisclosure(text: string): {
  category: string;
  icon: React.ReactNode;
  priority: number;
} {
  const lowerText = text.toLowerCase();

  if (lowerText.includes("patriot act") || lowerText.includes("usa patriot")) {
    return {
      category: "USA PATRIOT Act",
      icon: <Icon icon={Shield} size="md" />,
      priority: 1,
    };
  }

  if (lowerText.includes("sipc") || lowerText.includes("securities investor")) {
    return {
      category: "SIPC Protection",
      icon: <Icon icon={Shield} size="md" />,
      priority: 2,
    };
  }

  if (lowerText.includes("fdic")) {
    return {
      category: "FDIC Insurance",
      icon: <Icon icon={Shield} size="md" />,
      priority: 3,
    };
  }

  if (
    lowerText.includes("privacy") ||
    lowerText.includes("personal information")
  ) {
    return {
      category: "Privacy Notice",
      icon: <Icon icon={Scale} size="md" />,
      priority: 4,
    };
  }

  if (lowerText.includes("risk") || lowerText.includes("investment risk")) {
    return {
      category: "Risk Disclosure",
      icon: <Icon icon={Scale} size="md" />,
      priority: 5,
    };
  }

  return {
    category: "General Disclosure",
    icon: <Icon icon={FileText} size="md" />,
    priority: 10,
  };
}

function truncateText(text: string, maxLength: number = 150): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

// =============================================================================
// DISCLOSURE ITEM
// =============================================================================

interface DisclosureItemProps {
  text: string;
  index: number;
}

function DisclosureItem({ text, index: _index }: DisclosureItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { category, icon, priority } = categorizeDisclosure(text);

  const isLongText = text.length > 150;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          "border border-border/50 rounded-lg overflow-hidden",
          "transition-colors",
          isOpen ? "bg-muted/30" : "hover:bg-muted/20"
        )}
      >
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full p-3 flex items-start gap-3 text-left">
            <div
              className={cn(
                "p-1.5 rounded-lg shrink-0 mt-0.5",
                priority <= 3 ? "bg-primary/10" : "bg-muted"
              )}
            >
              {icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium">{category}</span>
                {priority <= 3 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 bg-primary/5"
                  >
                    Important
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">
                {truncateText(text)}
              </p>
            </div>
            {isLongText && (
              <div className="shrink-0 text-muted-foreground">
                {isOpen ? (
                  <Icon icon={ChevronUp} size="sm" />
                ) : (
                  <Icon icon={ChevronDown} size="sm" />
                )}
              </div>
            )}
          </button>
        </CollapsibleTrigger>

        {isLongText && (
          <CollapsibleContent>
            <div className="px-3 pb-3 pt-0">
              <div className="bg-background rounded-lg p-3 border border-border/30">
                <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {text}
                </p>
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

export function LegalDisclosuresCard({
  disclosures,
  className,
}: LegalDisclosuresCardProps) {
  const [showAll, setShowAll] = useState(false);

  if (!disclosures || disclosures.length === 0) {
    return null;
  }

  // Sort disclosures by priority
  const sortedDisclosures = [...disclosures].sort((a, b) => {
    const priorityA = categorizeDisclosure(a).priority;
    const priorityB = categorizeDisclosure(b).priority;
    return priorityA - priorityB;
  });

  // Show first 3 by default, or all if showAll is true
  const visibleDisclosures = showAll
    ? sortedDisclosures
    : sortedDisclosures.slice(0, 3);
  const hiddenCount = sortedDisclosures.length - 3;

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon icon={Scale} size="lg" className="text-muted-foreground" />
            <CardTitle className="text-base">Legal Disclosures</CardTitle>
          </div>
          <Badge variant="secondary" className="text-xs">
            {disclosures.length} disclosure{disclosures.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Extracted verbatim from your statement
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {visibleDisclosures.map((disclosure, index) => (
          <DisclosureItem key={index} text={disclosure} index={index} />
        ))}

        {hiddenCount > 0 && !showAll && (
          <Button
            variant="none"
            effect="fade"
            size="sm"
            showRipple={false}
            onClick={() => setShowAll(true)}
            className="w-full text-xs text-muted-foreground hover:text-foreground border border-transparent hover:border-border/50"
          >
            <Icon icon={ChevronDown} size="sm" className="mr-1" />
            Show {hiddenCount} more disclosure{hiddenCount !== 1 ? "s" : ""}
          </Button>
        )}

        {showAll && sortedDisclosures.length > 3 && (
          <Button
            variant="none"
            effect="fade"
            size="sm"
            showRipple={false}
            onClick={() => setShowAll(false)}
            className="w-full text-xs text-muted-foreground hover:text-foreground border border-transparent hover:border-border/50"
          >
            <Icon icon={ChevronUp} size="sm" className="mr-1" />
            Show less
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
